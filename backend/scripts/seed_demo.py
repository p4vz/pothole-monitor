#!/usr/bin/env python3
"""Seed a RoadSense API with synthetic drives so the viewer shows live data.

Simulates several passes over the same street by different devices — one stretch
with potholes — so segments accumulate roughness, defect probability, and
multi-device confidence.

Usage:
    python scripts/seed_demo.py [API_BASE]
    # API_BASE defaults to $ROADSENSE_SEED_API or the Railway URL below.

Dependency-free (stdlib only), so it runs anywhere without installing the app.
"""
import gzip
import json
import os
import sys
import urllib.request
from pathlib import Path

# Reuse the test signal generator.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.synth import make_batch  # noqa: E402

DEFAULT_API = "https://pothole-monitor-production.up.railway.app"
API = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ROADSENSE_SEED_API", DEFAULT_API)).rstrip("/")


def _post(path: str, data: bytes, headers: dict) -> dict:
    req = urllib.request.Request(f"{API}{path}", data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def register_device() -> str:
    out = _post("/v1/devices", b"{}", {"Content-Type": "application/json"})
    return out["token"]


def upload(batch: dict, token: str) -> dict:
    body = gzip.compress(json.dumps(batch).encode())
    return _post(
        "/v1/batches",
        body,
        {"Content-Type": "application/json", "Content-Encoding": "gzip", "X-Device-Token": token},
    )


def main() -> None:
    print(f"Seeding {API} ...")
    # 4 devices drive the same eastbound street; passes 0-2 hit two potholes,
    # pass 3 is a different (smooth) street to contrast.
    drives = [
        dict(lat0=52.3700, lng0=4.9000, heading_deg=90.0, potholes=[(5.0, 8.0), (5.1, 8.0)]),
        dict(lat0=52.3700, lng0=4.9000, heading_deg=90.0, potholes=[(5.0, 7.0), (5.1, 7.0)]),
        dict(lat0=52.3700, lng0=4.9000, heading_deg=90.0, potholes=[(5.0, 9.0)]),
        dict(lat0=52.3680, lng0=4.9000, heading_deg=90.0, potholes=[]),
    ]
    for i, d in enumerate(drives):
        token = register_device()  # a distinct device per pass
        batch = make_batch(f"seed-{i}", f"seed-dev-{i}", seed=100 + i, **d)
        ack = upload(batch, token)
        print(f"  pass {i}: device={token[:8]}… batch={ack['batch_id']} -> {ack['status']}")

    # Read back the aggregated result.
    with urllib.request.urlopen(f"{API}/v1/segments", timeout=30) as r:
        fc = json.loads(r.read().decode())
    print(f"\n{len(fc['features'])} segments now visible.")
    worst = sorted(fc["features"], key=lambda f: f["properties"]["roughness_score"], reverse=True)[:3]
    for f in worst:
        p = f["properties"]
        print(
            f"  {p['severity_class']:7s} roughness={p['roughness_score']:.2f} "
            f"defect={p['defect_probability']:.0%} conf={p['confidence']:.0%} "
            f"passes={p['n_passes']} devices={p['n_devices']}"
        )
    print("\nOpen the viewer (processing runs in the background — refresh after a few seconds).")


if __name__ == "__main__":
    main()
