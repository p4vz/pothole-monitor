"""End-to-end API: device registration, gzipped upload, processing, GeoJSON read."""
import gzip
import json

import pytest
from fastapi.testclient import TestClient

from app.db import Base, engine, init_db
from app.main import app
from tests.synth import make_batch


@pytest.fixture()
def client():
    Base.metadata.drop_all(engine)
    init_db()
    with TestClient(app) as c:  # TestClient runs BackgroundTasks synchronously
        yield c


def _register(client) -> str:
    r = client.post("/v1/devices", json={"app_version": "test"})
    assert r.status_code == 200
    return r.json()["token"]


def test_requires_device_token(client):
    assert client.post("/v1/batches", content=b"{}").status_code == 401


def test_full_roundtrip_gzip_upload_to_geojson(client):
    token = _register(client)
    batch = make_batch("api-1", "devX", potholes=[(5.0, 8.0), (5.1, 8.0)], seed=7)
    body = gzip.compress(json.dumps(batch).encode())
    r = client.post(
        "/v1/batches",
        content=body,
        headers={"X-Device-Token": token, "Content-Encoding": "gzip"},
    )
    assert r.status_code == 202
    assert r.json()["status"] == "pending"

    # Processing ran in the background task -> segments exist.
    fc = client.get("/v1/segments").json()
    assert fc["type"] == "FeatureCollection"
    assert fc["features"], "expected aggregated segments after processing"
    f = fc["features"][0]
    assert f["geometry"]["type"] == "Polygon"
    assert "roughness_score" in f["properties"]

    # bbox around Amsterdam returns data; a far-away bbox returns nothing.
    near = client.get("/v1/segments", params={"bbox": "4.85,52.35,4.95,52.40"}).json()
    assert near["features"]
    far = client.get("/v1/segments", params={"bbox": "-10,-10,-9,-9"}).json()
    assert far["features"] == []


def test_defects_cluster_across_devices(client):
    """Two distinct devices driving the same pothole produce one clustered
    defect with n_devices == 2 (independent of the H3 grid)."""
    for dev, seed in [("devA", 11), ("devB", 12)]:
        token = _register(client)  # each device gets its own identity
        batch = make_batch(f"def-{dev}", dev, potholes=[(5.0, 9.0), (5.1, 9.0)], seed=seed)
        client.post("/v1/batches", content=json.dumps(batch).encode(),
                    headers={"X-Device-Token": token})
    fc = client.get("/v1/defects").json()
    assert fc["type"] == "FeatureCollection"
    assert fc["features"], "expected at least one clustered defect"
    f = fc["features"][0]
    assert f["geometry"]["type"] == "Point"
    assert max(d["properties"]["n_devices"] for d in fc["features"]) == 2


def test_idempotent_reupload(client):
    token = _register(client)
    batch = make_batch("api-dup", "devX", seed=8)
    body = json.dumps(batch).encode()
    h = {"X-Device-Token": token}
    r1 = client.post("/v1/batches", content=body, headers=h)
    r2 = client.post("/v1/batches", content=body, headers=h)
    assert r1.status_code == 202
    assert r2.json()["duplicate"] is True


def test_segment_detail_has_history(client):
    token = _register(client)
    batch = make_batch("api-2", "devX", potholes=[(5.0, 8.0), (5.1, 8.0)], seed=9)
    client.post("/v1/batches", content=json.dumps(batch).encode(), headers={"X-Device-Token": token})
    key = client.get("/v1/segments").json()["features"][0]["properties"]["segment_key"]
    detail = client.get(f"/v1/segments/{key}").json()
    assert detail["n_passes"] >= 1
    assert isinstance(detail["history"], list) and detail["history"]


def test_segment_raw_returns_actual_samples(client):
    """Per-segment raw must yield the real IMU samples for that segment, sliced
    from the batch — what a per-segment Bayesian process consumes."""
    token = _register(client)
    batch = make_batch("api-raw", "devX", potholes=[(5.0, 9.0), (5.1, 9.0)], seed=3)
    client.post("/v1/batches", content=json.dumps(batch).encode(), headers={"X-Device-Token": token})
    # Pick the segment with the most events (where the pothole is).
    feats = client.get("/v1/segments").json()["features"]
    key = max(feats, key=lambda f: f["properties"]["roughness_score"])["properties"]["segment_key"]

    raw = client.get(f"/v1/segments/{key}/raw").json()
    assert raw["n_passes"] >= 1
    p = raw["passes"][0]
    # The slice carries real, length-consistent IMU arrays + a time range.
    n = p["n_samples"]
    assert n > 0
    assert len(p["imu"]["az"]) == n == len(p["imu"]["t"]) == len(p["imu"]["gz"])
    assert p["sample_range"][1] - p["sample_range"][0] >= n
    assert raw["total_samples"] >= n

    assert client.get("/v1/segments/nope/raw").status_code == 404
