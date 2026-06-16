"""FastAPI app: ingestion API (collector) + read API (viewer).

Ingestion stays intentionally thin — persist raw immutably, record metadata,
enqueue analysis, ack — so a slow pipeline never blocks uploads.
"""
from __future__ import annotations

import gzip
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import settings
from .db import SessionLocal, init_db
from .models import Device, RawBatch, SegmentObservation, SegmentState
from .pipeline import process_batch
from .schemas import BatchAck, BatchUpload, DeviceCreate, DeviceOut
from . import segmentation as seg
from .storage import get_store

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="RoadSense API", version="1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def require_device(
    x_device_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> Device:
    if not x_device_token:
        raise HTTPException(status_code=401, detail="missing X-Device-Token")
    device = db.get(Device, x_device_token)
    if device is None:
        raise HTTPException(status_code=401, detail="unknown device")
    return device


# --------------------------------------------------------------------------- #
# Collector endpoints
# --------------------------------------------------------------------------- #
@app.post("/v1/devices", response_model=DeviceOut)
def register_device(body: DeviceCreate, db: Session = Depends(get_db)) -> DeviceOut:
    device = Device(id=str(uuid.uuid4()), app_version=body.app_version)
    db.add(device)
    db.commit()
    # Dev token == id; production issues a signed JWT here.
    return DeviceOut(device_id=device.id, token=device.id)


@app.post("/v1/batches", response_model=BatchAck, status_code=202)
async def upload_batch(
    request: Request,
    background: BackgroundTasks,
    device: Device = Depends(require_device),
    db: Session = Depends(get_db),
) -> BatchAck:
    raw = await request.body()
    stored = raw  # keep exactly what the client sent (compressed) — immutable archive
    body = raw
    if raw[:2] == b"\x1f\x8b":
        body = gzip.decompress(raw)
    try:
        payload = BatchUpload.model_validate_json(body)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"invalid batch: {exc}")

    # Idempotency: a re-uploaded batch_id is acked without reprocessing.
    existing = db.get(RawBatch, payload.batch_id)
    if existing is not None:
        return BatchAck(batch_id=existing.id, status=existing.status, duplicate=True)

    t = payload.imu.t
    lats = [g.lat for g in payload.gps]
    lngs = [g.lng for g in payload.gps]
    key = f"batches/{device.id}/{payload.batch_id}.json.gz"
    # Store gzipped regardless of how it arrived, so the archive is uniform.
    get_store().put(key, stored if raw[:2] == b"\x1f\x8b" else gzip.compress(body))

    batch = RawBatch(
        id=payload.batch_id,
        session_id=payload.meta.session_id,
        device_id=device.id,
        storage_key=key,
        t_start=(t[0] if t else None),
        t_end=(t[-1] if t else None),
        min_lat=(min(lats) if lats else None),
        min_lng=(min(lngs) if lngs else None),
        max_lat=(max(lats) if lats else None),
        max_lng=(max(lngs) if lngs else None),
        n_samples=len(t),
        status="pending",
    )
    db.add(batch)
    db.commit()

    background.add_task(process_batch, payload.batch_id)
    return BatchAck(batch_id=batch.id, status="pending", duplicate=False)


# --------------------------------------------------------------------------- #
# Viewer (read) endpoints
# --------------------------------------------------------------------------- #
def _parse_bbox(bbox: str | None):
    if not bbox:
        return None
    try:
        min_lng, min_lat, max_lng, max_lat = (float(x) for x in bbox.split(","))
        return min_lng, min_lat, max_lng, max_lat
    except Exception:
        raise HTTPException(status_code=400, detail="bbox must be minLng,minLat,maxLng,maxLat")


@app.get("/v1/segments")
def get_segments(
    bbox: str | None = None,
    min_confidence: float = 0.0,
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(SegmentState).where(SegmentState.confidence >= min_confidence)
    box = _parse_bbox(bbox)
    if box:
        min_lng, min_lat, max_lng, max_lat = box
        stmt = stmt.where(
            SegmentState.center_lat >= min_lat,
            SegmentState.center_lat <= max_lat,
            SegmentState.center_lng >= min_lng,
            SegmentState.center_lng <= max_lng,
        )
    features = []
    for s in db.execute(stmt).scalars():
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [seg.cell_boundary_geojson(s.h3_index)],
                },
                "properties": {
                    "segment_key": s.segment_key,
                    "heading_bucket": s.heading_bucket,
                    "roughness_score": round(s.roughness_score, 3),
                    "severity_class": s.severity_class,
                    "confidence": round(s.confidence, 3),
                    "defect_probability": round(s.defect_probability, 3),
                    "pothole_probability": round(s.pothole_probability, 3),
                    "intensity_score": round(s.intensity_score, 3),
                    "intensity_class": s.intensity_class,
                    "swerve_rate": round(s.swerve_rate, 3),
                    "trend": s.trend,
                    "n_passes": s.n_passes,
                    "n_devices": s.n_devices,
                    "last_seen": s.last_seen.replace(tzinfo=timezone.utc).isoformat(),
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


@app.get("/v1/segments/{segment_key}")
def get_segment(segment_key: str, db: Session = Depends(get_db)) -> dict:
    s = db.get(SegmentState, segment_key)
    if s is None:
        raise HTTPException(status_code=404, detail="unknown segment")
    history = (
        db.execute(
            select(SegmentObservation)
            .where(SegmentObservation.segment_key == segment_key)
            .order_by(SegmentObservation.ts.desc())
            .limit(50)
        )
        .scalars()
        .all()
    )
    return {
        "segment_key": s.segment_key,
        "center": [s.center_lat, s.center_lng],
        "boundary": seg.cell_boundary_geojson(s.h3_index),
        "roughness_score": s.roughness_score,
        "severity_class": s.severity_class,
        "confidence": s.confidence,
        "defect_probability": s.defect_probability,
        "pothole_probability": s.pothole_probability,
        "intensity_score": s.intensity_score,
        "intensity_class": s.intensity_class,
        "intensity_mean_jerk": s.intensity_mean,
        "swerve_rate": s.swerve_rate,
        "n_hits": s.n_hits,
        "n_swerves": s.n_swerves,
        "n_clears": s.n_clears,
        "estimated_location": [s.loc_lat, s.loc_lng],
        "location_spread_m": s.loc_var_m2 ** 0.5,
        "trend": s.trend,
        "n_passes": s.n_passes,
        "n_devices": s.n_devices,
        "first_seen": s.first_seen.replace(tzinfo=timezone.utc).isoformat(),
        "last_seen": s.last_seen.replace(tzinfo=timezone.utc).isoformat(),
        "history": [
            {
                "ts": o.ts,
                "roughness": round(o.roughness, 3),
                "event_count": o.event_count,
                "max_severity": o.max_severity,
                "mean_speed": round(o.mean_speed, 2),
                "device_id": o.device_id,
            }
            for o in history
        ],
    }


# --------------------------------------------------------------------------- #
# Data inspection: overview + raw archive access
# --------------------------------------------------------------------------- #
@app.get("/v1/stats")
def stats(db: Session = Depends(get_db)) -> dict:
    """One-call overview: did raw data land, did it compile, and where is it?"""
    status_rows = db.execute(
        select(RawBatch.status, func.count()).group_by(RawBatch.status)
    ).all()
    bb = db.execute(
        select(
            func.min(SegmentState.center_lat), func.min(SegmentState.center_lng),
            func.max(SegmentState.center_lat), func.max(SegmentState.center_lng),
        )
    ).one()
    data_bbox = None
    if bb[0] is not None:
        data_bbox = {
            "min_lat": bb[0], "min_lng": bb[1], "max_lat": bb[2], "max_lng": bb[3],
            "center": [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2],
            "viewer": f"/viewer",  # viewer auto-fits to this
        }
    return {
        "devices": db.scalar(select(func.count()).select_from(Device)),
        "raw_batches": db.scalar(select(func.count()).select_from(RawBatch)),
        "raw_samples": int(db.scalar(select(func.coalesce(func.sum(RawBatch.n_samples), 0))) or 0),
        "batch_status": {s: c for s, c in status_rows},
        "observations": db.scalar(select(func.count()).select_from(SegmentObservation)),
        "segments": db.scalar(select(func.count()).select_from(SegmentState)),
        "data_bbox": data_bbox,
    }


@app.get("/v1/batches")
def list_batches(limit: int = 50, db: Session = Depends(get_db)) -> dict:
    """Recent raw uploads (metadata). Confirms data arrived and its processing state."""
    rows = (
        db.execute(select(RawBatch).order_by(RawBatch.t_start.desc()).limit(limit))
        .scalars()
        .all()
    )
    return {
        "batches": [
            {
                "batch_id": b.id,
                "device_id": b.device_id,
                "session_id": b.session_id,
                "status": b.status,
                "n_samples": b.n_samples,
                "t_start": b.t_start,
                "t_end": b.t_end,
                "bbox": ([b.min_lng, b.min_lat, b.max_lng, b.max_lat]
                         if b.min_lat is not None else None),
                "raw_url": f"/v1/batches/{b.id}/raw",
            }
            for b in rows
        ]
    }


@app.get("/v1/batches/{batch_id}/raw")
def get_raw_batch(batch_id: str, db: Session = Depends(get_db)) -> Response:
    """Download the immutable raw payload (decompressed JSON) exactly as uploaded."""
    b = db.get(RawBatch, batch_id)
    if b is None:
        raise HTTPException(status_code=404, detail="unknown batch")
    try:
        blob = get_store().get(b.storage_key)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="raw blob not found in storage")
    data = gzip.decompress(blob) if blob[:2] == b"\x1f\x8b" else blob
    return Response(
        content=data,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{batch_id}.json"'},
    )


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok", "h3_resolution": settings.h3_resolution}


# Serve the web collector (/) and viewer (/viewer) from the same origin as the
# API, so the browser needs no separate host and no CORS. Mounted LAST so the
# API routes above take precedence over this catch-all. Skipped if absent
# (e.g. during tests run from a checkout without the built web dir).
_WEB_DIR = Path(__file__).resolve().parent.parent / "web"
if _WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(_WEB_DIR), html=True), name="web")
