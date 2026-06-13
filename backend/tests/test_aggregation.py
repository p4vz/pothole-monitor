"""Aggregation: multi-pass folding, distinct-device confidence, and healing."""
from datetime import datetime, timedelta, timezone

from app.aggregation import fold
from app.analysis import Observation
from app.models import SegmentObservation
from app.segmentation import segment_for


def _obs(roughness, events, device, lat=52.37, lng=4.90, heading=90.0):
    key, h3idx, bucket = segment_for(lat, lng, heading)
    return Observation(
        segment_key=key,
        h3_index=h3idx,
        heading_bucket=bucket,
        ts=0.0,
        roughness=roughness,
        event_count=events,
        max_severity=2 if events else 0,
        mean_speed=13.0,
        quality=1.0,
        centroid_lat=lat,
        centroid_lng=lng,
    )


def _record(db, obs, device, when):
    """Mirror pipeline ordering: persist the observation, then fold."""
    db.add(
        SegmentObservation(
            segment_key=obs.segment_key,
            h3_index=obs.h3_index,
            heading_bucket=obs.heading_bucket,
            batch_id=f"b-{when.timestamp()}-{device}",
            device_id=device,
            ts=when.timestamp(),
            roughness=obs.roughness,
            event_count=obs.event_count,
            max_severity=obs.max_severity,
            mean_speed=obs.mean_speed,
            quality=obs.quality,
            centroid_lat=obs.centroid_lat,
            centroid_lng=obs.centroid_lng,
        )
    )
    db.flush()
    state = fold(db, obs, device, now=when)
    db.commit()
    return state


def test_single_pass_is_low_confidence(db):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    state = _record(db, _obs(2.5, 1, "dev-A"), "dev-A", now)
    assert state.n_passes == 1
    assert state.confidence < 0.3  # one pass, one device => not trusted yet


def test_agreement_across_passes_raises_confidence(db):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    state = None
    for i in range(6):
        state = _record(db, _obs(2.6, 1, "dev-A"), "dev-A", now + timedelta(hours=i))
    assert state.defect_probability > 0.8
    assert state.confidence > 0.0


def test_distinct_devices_beat_one_device_repeating(db):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    # Segment A: 4 passes, same device.
    a = None
    for i in range(4):
        a = _record(db, _obs(2.6, 1, "solo"), "solo", now + timedelta(hours=i))
    # Segment B (different location): 4 passes, 4 distinct devices.
    b = None
    for i in range(4):
        b = _record(
            db, _obs(2.6, 1, f"dev-{i}", lat=48.85, lng=2.35), f"dev-{i}",
            now + timedelta(hours=i),
        )
    assert b.n_devices == 4 and a.n_devices == 1
    assert b.confidence > a.confidence


def test_trend_tracks_worsening_then_improving(db):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    # Gradually worsening road -> trend should read "worsening".
    state = None
    for i, r in enumerate([0.5, 0.9, 1.4, 2.0, 2.6]):
        state = _record(db, _obs(r, 1 if r > 1.2 else 0, f"w{i}"), f"w{i}", now + timedelta(hours=i))
    assert state.trend == "worsening"

    # Then it is resurfaced and smooths out -> trend flips to "improving".
    for i, r in enumerate([1.5, 0.8, 0.3, 0.2]):
        state = _record(db, _obs(r, 0, f"i{i}"), f"i{i}", now + timedelta(hours=10 + i))
    assert state.trend == "improving"


def test_road_heals_after_repaving(db):
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    # Five rough passes -> severe, high defect probability.
    state = None
    for i in range(5):
        state = _record(db, _obs(4.0, 2, f"d{i}"), f"d{i}", now + timedelta(hours=i))
    assert state.severity_class in ("rough", "severe")
    assert state.defect_probability > 0.7

    # Repaving: a long gap, then smooth passes -> decay heals the segment.
    later = now + timedelta(days=400)
    for i in range(6):
        state = _record(
            db, _obs(0.2, 0, f"h{i}"), f"h{i}", later + timedelta(hours=i)
        )
    assert state.severity_class == "smooth"
    assert state.roughness_score < 1.0
    assert state.defect_probability < 0.5
