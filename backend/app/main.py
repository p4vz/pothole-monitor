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
from .models import Device, EventPoint, RawBatch, SegmentObservation, SegmentState
from .analysis import vertical_jerk_events
from .defects import cluster_defects
from .pipeline import _load_payload, process_batch
from .schemas import BatchAck, BatchUpload, DeviceCreate, DeviceOut
from . import segmentation as seg
from .storage import get_store

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    from .schema_sync import ensure_columns

    ensure_columns()  # self-heal schema drift from older deploys
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
                    # Precise sub-cell pothole marker (point + uncertainty radius).
                    "estimated_location": [s.loc_lat, s.loc_lng],
                    "location_spread_m": round((s.loc_var_m2 or 0.0) ** 0.5, 1),
                    "loc_weight": round(s.loc_weight, 2),
                    "last_seen": s.last_seen.replace(tzinfo=timezone.utc).isoformat(),
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


@app.get("/v1/defects")
def get_defects(bbox: str | None = None, db: Session = Depends(get_db)) -> dict:
    """Physical defects clustered from jolt points across passes/devices —
    independent of the H3 grid and heading. GeoJSON points for the viewer."""
    stmt = select(EventPoint)
    box = _parse_bbox(bbox)
    if box:
        min_lng, min_lat, max_lng, max_lat = box
        stmt = stmt.where(
            EventPoint.lat >= min_lat,
            EventPoint.lat <= max_lat,
            EventPoint.lng >= min_lng,
            EventPoint.lng <= max_lng,
        )
    points = list(db.execute(stmt).scalars())
    features = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [d["lng"], d["lat"]]},
            "properties": d,
        }
        for d in cluster_defects(points)
    ]
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
        "location_spread_m": (s.loc_var_m2 or 0.0) ** 0.5,
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
    # Storage diagnostics: is raw actually persisted? (the latest blob present,
    # and is the dir an absolute mounted path vs ephemeral ./_storage).
    latest = db.execute(
        select(RawBatch).order_by(RawBatch.received_at.desc()).limit(1)
    ).scalar_one_or_none()
    store = get_store()
    storage = {
        "dir": settings.storage_dir,
        "persisted": settings.storage_dir.startswith("/"),
        "latest_blob_present": bool(latest and store.exists(latest.storage_key)),
    }
    return {
        "devices": db.scalar(select(func.count()).select_from(Device)),
        "raw_batches": db.scalar(select(func.count()).select_from(RawBatch)),
        "raw_samples": int(db.scalar(select(func.coalesce(func.sum(RawBatch.n_samples), 0))) or 0),
        "batch_status": {s: c for s, c in status_rows},
        "observations": db.scalar(select(func.count()).select_from(SegmentObservation)),
        "segments": db.scalar(select(func.count()).select_from(SegmentState)),
        "data_bbox": data_bbox,
        "storage": storage,
    }


@app.post("/v1/reprocess")
def reprocess(db: Session = Depends(get_db)) -> dict:
    """Rebuild all derived data (observations + segment state) from the immutable
    raw batches — backfills new fields like per-segment sample ranges on data
    ingested by an older build. No-op-safe; needs the raw blobs to still exist."""
    from .pipeline import reprocess_all

    return reprocess_all()


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


@app.get("/v1/segments/{segment_key}/raw")
def get_segment_raw(segment_key: str, limit: int = 200, db: Session = Depends(get_db)) -> dict:
    """Per-segment raw sensor data: every pass's actual IMU+GPS samples, sliced
    from the immutable batch archive via the stored index range. This is what a
    backend process needs to run per-segment Bayesian statistics on real data."""
    if db.get(SegmentState, segment_key) is None:
        raise HTTPException(status_code=404, detail="unknown segment")
    rows = (
        db.execute(
            select(SegmentObservation)
            .where(SegmentObservation.segment_key == segment_key)
            .order_by(SegmentObservation.ts.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    cache: dict[str, dict] = {}
    passes = []
    skipped = {"missing_blob": 0, "no_sample_range": 0}
    for o in rows:
        batch = db.get(RawBatch, o.batch_id)
        if batch is None:
            skipped["missing_blob"] += 1
            continue
        payload = cache.get(o.batch_id)
        if payload is None:
            try:
                payload = _load_payload(get_store().get(batch.storage_key))
            except FileNotFoundError:
                skipped["missing_blob"] += 1
                continue
            cache[o.batch_id] = payload
        imu = payload.get("imu", {})
        t = imu.get("t", [])
        s, e = o.sample_start, min(o.sample_end, len(t))
        if e <= s:
            skipped["no_sample_range"] += 1  # ingested before sample ranges existed
            continue
        imu_slice = {k: imu.get(k, [])[s:e] for k in ("t", "ax", "ay", "az", "gx", "gy", "gz")}
        t0, t1 = t[s], t[e - 1]
        gps = [g for g in payload.get("gps", []) if t0 <= g.get("t", 0) <= t1]
        passes.append(
            {
                "batch_id": o.batch_id,
                "device_id": o.device_id,
                "ts": o.ts,
                "sample_range": [o.sample_start, o.sample_end],
                "n_samples": e - s,
                "imu": imu_slice,
                "gps": gps,
                "events": vertical_jerk_events(imu_slice),  # jolt markers for the plot
            }
        )
    note = None
    if not passes and rows:
        if skipped["missing_blob"]:
            note = "Raw blobs are missing from storage (not persisted across redeploys). Set ROADSENSE_STORAGE_DIR to a mounted volume and re-record."
        elif skipped["no_sample_range"]:
            note = "These passes were ingested before per-segment sample ranges existed. POST /v1/reprocess (or use 'Rebuild from raw' on /data) to backfill them."
    return {
        "segment_key": segment_key,
        "n_passes": len(passes),
        "total_samples": sum(p["n_samples"] for p in passes),
        "passes": passes,
        "skipped": skipped,
        "note": note,
    }


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
