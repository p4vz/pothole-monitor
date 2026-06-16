"""Backend process: per-segment statistics computed from RAW sensor data.

This is the process the goal calls for: it walks every segment, reconstructs
each pass's actual IMU/GPS samples from the immutable batch archive (via the
sample-index range stored on each observation), re-runs the windowed analysis
on the real samples, and reports a per-segment distribution the cached
summaries can't give — the spread of vertical-jerk peaks and the
hit / swerve / clear mix that the Bayesian pothole model rests on.

    python -m scripts.segment_raw_stats            # all segments
    python -m scripts.segment_raw_stats <key>      # one segment

Because it reads from immutable raw, the algorithm can be changed and the whole
history re-evaluated without ever re-collecting data.
"""
from __future__ import annotations

import gzip
import json
import statistics
import sys

from sqlalchemy import select

from app.analysis import analyze
from app.bayesian import classify_pass
from app.db import SessionLocal
from app.models import RawBatch, SegmentObservation, SegmentState
from app.storage import get_store


def _payload(store_cache: dict, batch: RawBatch) -> dict | None:
    if batch.id not in store_cache:
        try:
            raw = get_store().get(batch.storage_key)
        except FileNotFoundError:
            return None
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        store_cache[batch.id] = json.loads(raw.decode("utf-8"))
    return store_cache[batch.id]


def _slice_payload(payload: dict, s: int, e: int) -> dict:
    imu = payload.get("imu", {})
    t = imu.get("t", [])
    e = min(e, len(t))
    imu_slice = {k: imu.get(k, [])[s:e] for k in ("t", "ax", "ay", "az", "gx", "gy", "gz")}
    if not imu_slice["t"]:
        return {}
    t0, t1 = imu_slice["t"][0], imu_slice["t"][-1]
    gps = [g for g in payload.get("gps", []) if t0 <= g.get("t", 0) <= t1]
    return {"meta": {"session_id": None}, "imu": imu_slice, "gps": gps}


def segment_raw_stats(segment_key: str) -> dict | None:
    """Recompute per-segment evidence from raw samples for one segment."""
    session = SessionLocal()
    cache: dict = {}
    try:
        state = session.get(SegmentState, segment_key)
        if state is None:
            return None
        rows = (
            session.execute(
                select(SegmentObservation).where(SegmentObservation.segment_key == segment_key)
            )
            .scalars()
            .all()
        )
        peaks: list[float] = []
        counts = {"hit": 0, "swerve": 0, "clear": 0}
        for o in rows:
            batch = session.get(RawBatch, o.batch_id)
            if batch is None:
                continue
            payload = _payload(cache, batch)
            if payload is None:
                continue
            sliced = _slice_payload(payload, o.sample_start, o.sample_end)
            if not sliced:
                continue
            # Re-run analysis on the raw slice; take the obs for this segment.
            obs_list = [o2 for o2 in analyze(sliced) if o2.segment_key == segment_key] or analyze(sliced)
            if not obs_list:
                continue
            obs = max(obs_list, key=lambda x: x.vert_peak)
            klass, mag = classify_pass(obs)
            counts[klass] += 1
            if mag > 0:
                peaks.append(mag)
        return {
            "segment_key": segment_key,
            "passes": len(rows),
            "hits": counts["hit"],
            "swerves": counts["swerve"],
            "clears": counts["clear"],
            "jerk_peak_mean": round(statistics.fmean(peaks), 2) if peaks else 0.0,
            "jerk_peak_std": round(statistics.pstdev(peaks), 2) if len(peaks) > 1 else 0.0,
            "jerk_peak_max": round(max(peaks), 2) if peaks else 0.0,
            "stored_pothole_probability": round(state.pothole_probability, 3),
            "stored_intensity_class": state.intensity_class,
        }
    finally:
        session.close()


def main() -> None:
    session = SessionLocal()
    try:
        keys = (
            [sys.argv[1]]
            if len(sys.argv) > 1
            else list(session.execute(select(SegmentState.segment_key)).scalars())
        )
    finally:
        session.close()
    if not keys:
        print("no segments yet — ingest some drives first.")
        return
    hdr = f"{'segment':20} {'passes':>6} {'hit':>4} {'swrv':>4} {'clr':>4} {'jerk(mean/max)':>16} {'P(hole)':>8} intensity"
    print(hdr)
    print("-" * len(hdr))
    for key in keys:
        r = segment_raw_stats(key)
        if r:
            print(
                f"{r['segment_key'][:20]:20} {r['passes']:>6} {r['hits']:>4} {r['swerves']:>4} "
                f"{r['clears']:>4} {r['jerk_peak_mean']:>7}/{r['jerk_peak_max']:<8} "
                f"{r['stored_pothole_probability']:>8} {r['stored_intensity_class']}"
            )


if __name__ == "__main__":
    main()
