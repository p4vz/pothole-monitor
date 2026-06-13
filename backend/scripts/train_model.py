#!/usr/bin/env python3
"""Train the defect model from stored raw batches and save it for inference.

    python scripts/train_model.py [OUTPUT_PATH]   # default: model.json

By default it distils the heuristic (weak supervision) so you get a working
model before any human labels exist. When you have real labels, replace
`label_fn` with a lookup into your labels table/CSV and rerun.

Point the API at the result with ROADSENSE_MODEL_PATH=model.json and restart;
the pipeline then scores windows with the model instead of the heuristic.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.ml import dataset_from_batches, train_logreg  # noqa: E402
from app.models import RawBatch  # noqa: E402
from app.pipeline import _load_payload  # noqa: E402
from app.storage import get_store  # noqa: E402


def load_payloads():
    session = SessionLocal()
    try:
        store = get_store()
        for batch in session.query(RawBatch).all():
            try:
                yield _load_payload(store.get(batch.storage_key))
            except Exception:
                continue
    finally:
        session.close()


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else "model.json"
    payloads = list(load_payloads())
    if not payloads:
        print("No raw batches found — collect/seed data first.")
        return

    # Weak labels: a window is a defect if the heuristic detected an event.
    def label_fn(w):
        return 1 if w.event_count > 0 else 0

    X, y = dataset_from_batches(payloads, label_fn, settings)
    pos = sum(y)
    print(f"{len(payloads)} batches -> {len(X)} windows ({pos} positive)")
    if pos == 0 or pos == len(y):
        print("Need both defect and clean windows to train.")
        return

    model = train_logreg(X, y)
    preds = (model.predict_proba(X) >= 0.5).astype(int)
    acc = float((preds == y).mean())
    model.save(out)
    print(f"train accuracy {acc:.3f} -> saved {out}")
    print(f"Set ROADSENSE_MODEL_PATH={out} and restart the API to use it.")


if __name__ == "__main__":
    main()
