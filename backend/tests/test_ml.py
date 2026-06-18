"""ML path: feature extraction, training, inference, and heuristic fallback."""
import numpy as np

from app.analysis import analyze, compute_windows
from app.ml import FEATURE_NAMES, RoughnessModel, dataset_from_batches, train_logreg
from tests.synth import make_batch


def _labeled_batches(n=6):
    """Half pothole-laden, half smooth — with ground-truth window labels."""
    batches = []
    for i in range(n):
        if i % 2 == 0:
            batches.append(make_batch(f"hole-{i}", f"d{i}", potholes=[(5.0, 8.0), (5.1, 8.0)], seed=i))
        else:
            batches.append(make_batch(f"smooth-{i}", f"d{i}", potholes=[], seed=i))
    return batches


def test_feature_vector_matches_names():
    w = compute_windows(make_batch("b", "d", seed=1))[0]
    assert len(w.vector()) == len(FEATURE_NAMES)


def test_model_learns_to_separate_potholes():
    batches = _labeled_batches()
    # Weak-label by the heuristic (distillation) — the model should recover it.
    X, y = dataset_from_batches(batches, lambda w: 1 if w.event_count > 0 else 0)
    assert 0 < sum(y) < len(y)  # both classes present
    model = train_logreg(X, y)
    preds = (model.predict_proba(X) >= 0.5).astype(int)
    assert (preds == np.asarray(y)).mean() > 0.9


def test_scorer_overrides_heuristic_in_analyze():
    batch = make_batch("b-score", "d", potholes=[(5.0, 8.0), (5.1, 8.0)], seed=2)

    # A model that flags everything as a defect should raise event counts vs the
    # heuristic path on the same batch.
    class AllDefect(RoughnessModel):
        def __init__(self):
            pass

        def score_window(self, w):
            return 1, 2

    heuristic = sum(o.event_count for o in analyze(batch))
    forced = sum(o.event_count for o in analyze(batch, scorer=AllDefect()))
    assert forced > heuristic


def test_save_load_roundtrip(tmp_path):
    X, y = dataset_from_batches(_labeled_batches(), lambda w: 1 if w.event_count > 0 else 0)
    model = train_logreg(X, y)
    p = tmp_path / "m.json"
    model.save(str(p))
    reloaded = RoughnessModel.load(str(p))
    assert np.allclose(model.predict_proba(X), reloaded.predict_proba(X))
