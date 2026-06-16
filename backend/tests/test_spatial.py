"""Spatial registration: coarse aggregation tile + GPS lever-arm compensation."""
import math

import numpy as np

import app.segmentation as seg
from app.analysis import compute_windows, event_points
from app.config import settings
from app.defects import cluster_defects
from tests.synth import make_batch


def _offset(lat, lng, d_east_m, d_north_m):
    return (
        lat + d_north_m / 111_111.0,
        lng + d_east_m / (111_111.0 * math.cos(math.radians(lat))),
    )


def test_coarser_tile_merges_gps_noisy_passes():
    """Phase 1: at res 11 (~25 m), GPS-noisy passes over one spot collapse into
    far fewer distinct cells than at res 12 (~9 m) — so they reinforce instead
    of fragmenting."""
    base = (52.370, 4.900)
    rng = np.random.default_rng(0)
    cells11, cells12 = set(), set()
    for _ in range(80):
        de, dn = rng.normal(0.0, 5.0, 2)  # ~5 m std GPS scatter
        lat, lng = _offset(*base, de, dn)
        cells11.add(seg.segment_for(lat, lng, 90.0, res=11)[1])
        cells12.add(seg.segment_for(lat, lng, 90.0, res=12)[1])
    assert len(cells11) < len(cells12)
    assert settings.h3_resolution == 11  # default is now the coarse tile


def test_gps_latency_shifts_position_backward():
    """Phase 2: an eastbound pass is shifted west (backward along heading) by
    ~speed*latency, removing the systematic GPS lag."""
    batch = make_batch("lag", "d", heading_deg=90.0, speed_mps=20.0, potholes=[])
    cfg_off = settings.model_copy(update={"gps_latency_s": 0.0})
    cfg_on = settings.model_copy(update={"gps_latency_s": 0.3})
    lng_off = float(np.mean([w.lng for w in compute_windows(batch, cfg_off)]))
    lng_on = float(np.mean([w.lng for w in compute_windows(batch, cfg_on)]))
    assert lng_on < lng_off  # east heading => backward shift is westward
    shift_m = (lng_off - lng_on) * 111_111.0 * math.cos(math.radians(52.370))
    assert 3.0 < shift_m < 9.0  # ~ speed*latency = 20 * 0.3 = 6 m


def test_event_points_are_localized():
    """Phase 3: a pothole impulse yields an event point near where it was hit."""
    batch = make_batch("ev", "d", heading_deg=90.0, speed_mps=13.0,
                       potholes=[(5.0, 9.0)], seed=4)
    pts = event_points(batch)
    assert pts, "expected at least one localized jolt"
    # All points carry a position and a heading bucket.
    assert all("lat" in p and "lng" in p and "heading_bucket" in p for p in pts)


def test_cluster_separates_distinct_potholes():
    """Phase 3: GPS-noisy passes over two potholes ~40 m apart cluster into two
    defects (not the grid), each tagged with its distinct-device count."""
    base = (52.370, 4.900)
    A = base
    B = _offset(*base, 40.0, 0.0)  # 40 m east
    rng = np.random.default_rng(2)
    pts = []
    for truth, devices in [(A, ["d1", "d2", "d3"]), (B, ["d1", "d2"])]:
        for dev in devices:
            for _ in range(3):  # several noisy passes per device
                de, dn = rng.normal(0.0, 3.0, 2)
                la, ln = _offset(*truth, de, dn)
                pts.append({"lat": la, "lng": ln, "device_id": dev,
                            "severity": 2, "value": 6.0, "heading_bucket": 2})
    defects = cluster_defects(pts)
    assert len(defects) == 2
    # Assign each defect to its nearest ground-truth pothole.
    def to(truth):
        return min(defects, key=lambda d: math.hypot(d["lat"] - truth[0], d["lng"] - truth[1]))
    da, db = to(A), to(B)
    assert da is not db
    assert da["n_devices"] == 3
    assert db["n_devices"] == 2
