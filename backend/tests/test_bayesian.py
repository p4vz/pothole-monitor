"""Bayesian pothole inference: hit/swerve classification and multi-pass fusion."""
from datetime import datetime, timedelta, timezone

from app.analysis import Observation, analyze
from app.bayesian import CLEAR, HIT, SWERVE, classify_pass
from app.models import SegmentObservation
from app.aggregation import fold
from tests.synth import make_batch


# ----------------------- per-pass classification -----------------------------
def _obs(**kw):
    base = dict(
        segment_key="k", h3_index="8c1969c9b275dff", heading_bucket=0, ts=0.0,
        roughness=0.2, event_count=0, max_severity=0, mean_speed=13.0, quality=1.0,
        centroid_lat=52.37, centroid_lng=4.90, vert_peak=0.2, yaw_out=0.0,
        yaw_back=0.0, lateral_rms=0.0,
    )
    base.update(kw)
    return Observation(**base)


def test_classify_hit_swerve_clear_and_turn():
    assert classify_pass(_obs(event_count=1, vert_peak=8.0))[0] == HIT
    # Out-and-back yaw => swerve.
    assert classify_pass(_obs(yaw_out=0.4, yaw_back=0.4))[0] == SWERVE
    # Sustained one-direction yaw (a turn) is NOT a swerve.
    assert classify_pass(_obs(yaw_out=0.6, yaw_back=0.0))[0] == CLEAR
    assert classify_pass(_obs())[0] == CLEAR


def test_swerve_detected_from_synthetic_batch():
    batch = make_batch("sw", "d", potholes=[], swerves=[(6.0, 0.6)], seed=11)
    classes = {classify_pass(o)[0] for o in analyze(batch)}
    assert SWERVE in classes


# ----------------------- multi-pass Bayesian fusion --------------------------
def _record(db, obs, device, when):
    db.add(SegmentObservation(
        segment_key=obs.segment_key, h3_index=obs.h3_index, heading_bucket=obs.heading_bucket,
        batch_id=f"b-{when.timestamp()}-{device}", device_id=device, ts=when.timestamp(),
        roughness=obs.roughness, event_count=obs.event_count, max_severity=obs.max_severity,
        mean_speed=obs.mean_speed, quality=obs.quality,
        centroid_lat=obs.centroid_lat, centroid_lng=obs.centroid_lng,
    ))
    db.flush()
    state = fold(db, obs, device, now=when)
    db.commit()
    return state


def test_mostly_swervers_still_flag_pothole(db):
    """2 hit, 5 swerve, 1 clear — vertical-only would look near-smooth, but the
    fused model should be confident a (large, avoided) pothole exists."""
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    passes = (
        [_obs(event_count=1, vert_peak=10.0) for _ in range(2)]
        + [_obs(yaw_out=0.5, yaw_back=0.5, lateral_rms=2.0) for _ in range(5)]
        + [_obs()]
    )
    state = None
    for i, o in enumerate(passes):
        state = _record(db, o, f"dev-{i}", now + timedelta(hours=i))
    assert state.pothole_probability > 0.8
    assert state.swerve_rate > 0.5            # mostly avoided
    assert state.intensity_class in ("medium", "large")  # big jerk + high avoidance


def test_all_clear_stays_low_probability(db):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    state = None
    for i in range(6):
        state = _record(db, _obs(), f"d{i}", now + timedelta(hours=i))
    assert state.pothole_probability < 0.2
    assert state.intensity_class == "none"


def test_location_estimate_near_truth(db):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    # Hits at a precise spot pull the location estimate toward it.
    state = None
    for i in range(4):
        state = _record(
            db, _obs(event_count=1, vert_peak=9.0, centroid_lat=52.3710, centroid_lng=4.9005),
            f"d{i}", now + timedelta(hours=i),
        )
    assert abs(state.loc_lat - 52.3710) < 1e-4
    assert abs(state.loc_lng - 4.9005) < 1e-4
