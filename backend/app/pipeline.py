"""Batch processing orchestration: raw blob -> observations -> segment state.

Pure function `process_batch(batch_id)` so it can run in-process (BackgroundTasks)
in dev or inside an RQ/Celery worker in production — same code path either way.
"""
from __future__ import annotations

import gzip
import json
from datetime import datetime, timezone

from .aggregation import fold
from .analysis import analyze
from .db import SessionLocal
from .models import RawBatch, SegmentObservation
from .storage import get_store


def _load_payload(raw: bytes) -> dict:
    if raw[:2] == b"\x1f\x8b":  # gzip magic
        raw = gzip.decompress(raw)
    return json.loads(raw.decode("utf-8"))


def reprocess_all() -> dict:
    """Rebuild ALL derived data (observations + segment state) from the immutable
    raw batches. Use after an algorithm change or to backfill new fields (e.g.
    per-segment sample ranges) on data ingested by an older build. Requires the
    raw blobs to still exist in storage."""
    from sqlalchemy import delete, select, update

    from .models import SegmentObservation, SegmentState

    session = SessionLocal()
    try:
        session.execute(delete(SegmentObservation))
        session.execute(delete(SegmentState))
        session.execute(update(RawBatch).values(status="pending", processed_at=None, error=None))
        session.commit()
        # Process chronologically so recency-decay/trend reproduce live state
        # (live ingestion is time-ordered; id order is not).
        ids = list(
            session.execute(
                select(RawBatch.id).order_by(RawBatch.t_start, RawBatch.received_at)
            ).scalars()
        )
    finally:
        session.close()

    ok = missing = failed = 0
    for bid in ids:
        try:
            process_batch(bid)
            ok += 1
        except FileNotFoundError:
            missing += 1  # raw blob gone (storage wasn't persisted)
        except Exception:  # noqa: BLE001
            failed += 1
    return {"total": len(ids), "reprocessed": ok, "missing_raw": missing, "failed": failed}


def process_batch(batch_id: str) -> int:
    """Process one stored raw batch. Returns number of observations emitted."""
    session = SessionLocal()
    try:
        batch = session.get(RawBatch, batch_id)
        if batch is None or batch.status == "processed":
            return 0
        try:
            from .ml import get_model

            payload = _load_payload(get_store().get(batch.storage_key))
            observations = analyze(payload, scorer=get_model())
            for obs in observations:
                # Insert the observation first so the distinct-device count in
                # fold() includes this pass.
                session.add(
                    SegmentObservation(
                        segment_key=obs.segment_key,
                        h3_index=obs.h3_index,
                        heading_bucket=obs.heading_bucket,
                        batch_id=batch.id,
                        session_id=batch.session_id,
                        device_id=batch.device_id,
                        ts=obs.ts,
                        roughness=obs.roughness,
                        event_count=obs.event_count,
                        max_severity=obs.max_severity,
                        mean_speed=obs.mean_speed,
                        quality=obs.quality,
                        centroid_lat=obs.centroid_lat,
                        centroid_lng=obs.centroid_lng,
                        sample_start=obs.sample_start,
                        sample_end=obs.sample_end,
                    )
                )
                session.flush()
                ref_time = (
                    datetime.fromtimestamp(obs.ts, tz=timezone.utc)
                    if obs.ts
                    else batch.received_at
                )
                fold(session, obs, batch.device_id, now=ref_time)
            batch.status = "processed"
            batch.processed_at = datetime.now(timezone.utc)
            session.commit()
            return len(observations)
        except Exception as exc:  # noqa: BLE001 — record failure, keep raw for retry
            session.rollback()
            batch = session.get(RawBatch, batch_id)
            if batch is not None:
                batch.status = "failed"
                batch.error = str(exc)[:500]
                session.commit()
            raise
    finally:
        session.close()
