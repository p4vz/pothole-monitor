"""Analysis pipeline: detection, localisation, and quality gating."""
import h3

from app.analysis import analyze
from app.config import settings
from tests.synth import make_batch


def test_smooth_road_is_low_roughness_no_events():
    batch = make_batch("b-smooth", "dev-1", noise_std=0.12, potholes=[], seed=1)
    obs = analyze(batch)
    assert obs, "expected at least one segment observation"
    assert all(o.event_count == 0 for o in obs)
    assert max(o.roughness for o in obs) < settings.defect_roughness_thresh


def test_pothole_is_detected_and_localised():
    # Two strong impulses a few seconds into the drive.
    batch = make_batch(
        "b-hole", "dev-1", noise_std=0.12, potholes=[(5.0, 8.0), (5.1, 8.0)], seed=2
    )
    obs = analyze(batch)
    assert obs
    hit = [o for o in obs if o.event_count > 0]
    assert hit, "pothole impulse should produce a detected event"
    o = max(hit, key=lambda x: x.max_severity)
    assert o.max_severity >= 2  # medium or larger

    # Localised to (about) the right H3 cell: the impulse happened ~5 s in.
    speed, fs = 13.0, 50
    lat0, lng0 = 52.370, 4.900
    import math

    d = speed * 5.0
    exp_lng = lng0 + d / (111_111.0 * math.cos(math.radians(lat0)))
    expected_cell = h3.latlng_to_cell(lat0, exp_lng, settings.h3_resolution)
    # Allow the neighbour ring (window centroids straddle cell edges).
    neighbourhood = h3.grid_disk(expected_cell, 1)
    assert o.h3_index in neighbourhood


def test_trip_trimming_drops_trip_endpoints():
    batch = make_batch("b-trim", "dev-1", potholes=[], seed=5)
    full = analyze(batch)
    trimmed = analyze(batch, cfg=settings.model_copy(update={"trip_trim_meters": 40.0}))
    # Trimming the first/last 40 m removes the edge segments along the ~156 m drive.
    assert 0 < len(trimmed) < len(full)


def test_idle_low_speed_is_gated_out():
    # Below min_speed everything should be dropped -> no observations.
    batch = make_batch("b-idle", "dev-1", speed_mps=1.0, potholes=[(3.0, 8.0)], seed=3)
    assert analyze(batch) == []


def test_arbitrary_mount_gravity_removed():
    # Rotate the phone ~90deg so the road-normal axis (gravity + the pothole
    # jolt, which act together) is on x instead of z. Reorientation must still
    # recover the impulse.
    batch = make_batch("b-mount", "dev-1", potholes=[(5.0, 8.0), (5.1, 8.0)], seed=4)
    n = len(batch["imu"]["t"])
    az = batch["imu"]["az"]  # = gravity + vertical motion
    batch["imu"]["ax"] = list(az)                       # gravity + jolt now on x
    batch["imu"]["az"] = [0.05 for _ in range(n)]       # z is now near-zero
    obs = analyze(batch)
    assert any(o.event_count > 0 for o in obs)
