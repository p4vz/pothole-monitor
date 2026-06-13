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
