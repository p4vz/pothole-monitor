"""Supervised defect model (v1) — data-ready ML path.

A small, dependency-free logistic regression over the per-window features from
`analysis.compute_windows`. Until a model file exists, the pipeline keeps using
the heuristic; once you train one (`scripts/train_model.py`) on collected data,
inference swaps in transparently via `analyze(..., scorer=get_model())`.

Numpy-only on purpose so it runs anywhere. For production-grade models, retrain
with scikit-learn (gradient boosting etc.) and load it behind the same
`score_window` interface — nothing else changes.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .analysis import WindowFeat, severity_from_peak
from .config import settings

FEATURE_NAMES = ["rms", "peak", "peak_count", "p2p", "mean_speed"]


class RoughnessModel:
    def __init__(self, weights, bias, mean, std, threshold=0.5):
        self.w = np.asarray(weights, float)
        self.b = float(bias)
        self.mean = np.asarray(mean, float)
        self.std = np.asarray(std, float)
        self.threshold = float(threshold)

    def predict_proba(self, X) -> np.ndarray:
        Xs = (np.asarray(X, float) - self.mean) / self.std
        return 1.0 / (1.0 + np.exp(-(Xs @ self.w + self.b)))

    def score_window(self, w: WindowFeat) -> tuple[int, int]:
        """Return (event_count, max_severity) — the model decides defect presence;
        magnitude still comes from the peak so severity stays interpretable."""
        p = float(self.predict_proba([w.vector()])[0])
        if p >= self.threshold:
            return 1, max(1, severity_from_peak(w.peak))
        return 0, 0

    def save(self, path: str) -> None:
        Path(path).write_text(
            json.dumps(
                {
                    "feature_names": FEATURE_NAMES,
                    "weights": self.w.tolist(),
                    "bias": self.b,
                    "mean": self.mean.tolist(),
                    "std": self.std.tolist(),
                    "threshold": self.threshold,
                }
            )
        )

    @classmethod
    def load(cls, path: str) -> "RoughnessModel":
        d = json.loads(Path(path).read_text())
        return cls(d["weights"], d["bias"], d["mean"], d["std"], d.get("threshold", 0.5))


def train_logreg(X, y, epochs: int = 400, lr: float = 0.2, l2: float = 1e-3) -> RoughnessModel:
    X = np.asarray(X, float)
    y = np.asarray(y, float)
    mean = X.mean(axis=0)
    std = X.std(axis=0)
    std[std < 1e-9] = 1.0
    Xs = (X - mean) / std
    n, d = Xs.shape
    w = np.zeros(d)
    b = 0.0
    for _ in range(epochs):
        p = 1.0 / (1.0 + np.exp(-(Xs @ w + b)))
        gw = Xs.T @ (p - y) / n + l2 * w
        gb = float((p - y).mean())
        w -= lr * gw
        b -= lr * gb
    return RoughnessModel(w.tolist(), b, mean.tolist(), std.tolist())


def dataset_from_batches(batches, label_fn, cfg=settings):
    """Build (X, y) from raw batch payloads. `label_fn(window) -> 0|1`.

    With no human labels yet, pass the heuristic as a weak labeller to distil it
    into a model (bootstrapping); replace with real labels when you have them."""
    from .analysis import compute_windows

    X, y = [], []
    for payload in batches:
        for w in compute_windows(payload, cfg):
            if w.quality < cfg.min_window_quality:
                continue
            X.append(w.vector())
            y.append(int(label_fn(w)))
    return X, y


_model: RoughnessModel | None = None
_loaded = False


def get_model() -> RoughnessModel | None:
    """Cached model from settings.model_path, or None to use the heuristic."""
    global _model, _loaded
    if not _loaded:
        _loaded = True
        if settings.model_path and Path(settings.model_path).exists():
            _model = RoughnessModel.load(settings.model_path)
    return _model
