"""SQLAlchemy ORM models.

Raw time-series blobs live in object storage (storage.py); only metadata and
derived state live in the database. This keeps the DB small and lets the
analysis be re-run from immutable raw data whenever the algorithm improves.
"""
from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Device(Base):
    __tablename__ = "devices"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    app_version: Mapped[str | None] = mapped_column(String, nullable=True)


class IngestSession(Base):
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sample_rate: Mapped[int | None] = mapped_column(Integer, nullable=True)
    app_version: Mapped[str | None] = mapped_column(String, nullable=True)


class RawBatch(Base):
    """One uploaded 1-5 min batch. status: pending -> processed | failed."""

    __tablename__ = "raw_batches"
    id: Mapped[str] = mapped_column(String, primary_key=True)  # client batch UUID (idempotent)
    session_id: Mapped[str | None] = mapped_column(String, nullable=True)
    device_id: Mapped[str] = mapped_column(String, index=True)
    storage_key: Mapped[str] = mapped_column(String)
    t_start: Mapped[float | None] = mapped_column(Float, nullable=True)
    t_end: Mapped[float | None] = mapped_column(Float, nullable=True)
    min_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    min_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    n_samples: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String, default="pending", index=True)
    error: Mapped[str | None] = mapped_column(String, nullable=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SegmentObservation(Base):
    """One pass over one segment within one batch. Kept for history / re-aggregation."""

    __tablename__ = "segment_observations"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    segment_key: Mapped[str] = mapped_column(String, index=True)
    h3_index: Mapped[str] = mapped_column(String)
    heading_bucket: Mapped[int] = mapped_column(Integer)
    batch_id: Mapped[str] = mapped_column(String, index=True)
    session_id: Mapped[str | None] = mapped_column(String, nullable=True)
    device_id: Mapped[str] = mapped_column(String, index=True)
    ts: Mapped[float] = mapped_column(Float)  # epoch seconds of the pass
    roughness: Mapped[float] = mapped_column(Float)
    event_count: Mapped[int] = mapped_column(Integer)
    max_severity: Mapped[int] = mapped_column(Integer)
    mean_speed: Mapped[float] = mapped_column(Float)
    quality: Mapped[float] = mapped_column(Float)
    centroid_lat: Mapped[float] = mapped_column(Float)
    centroid_lng: Mapped[float] = mapped_column(Float)
    # Raw sample index range [sample_start, sample_end) into the batch's IMU
    # arrays for this pass, so the segment's raw sensor data is addressable
    # (reconstructed on demand from the immutable batch blob).
    sample_start: Mapped[int] = mapped_column(Integer, default=0)
    sample_end: Mapped[int] = mapped_column(Integer, default=0)


class SegmentState(Base):
    """Aggregated, continuously-updated condition for one road segment.

    mean/m2/n_eff drive a decayed running roughness estimate (heals over time);
    alpha/beta are a Beta posterior over "a defect exists here".
    """

    __tablename__ = "segment_state"
    segment_key: Mapped[str] = mapped_column(String, primary_key=True)
    h3_index: Mapped[str] = mapped_column(String, index=True)
    heading_bucket: Mapped[int] = mapped_column(Integer)
    center_lat: Mapped[float] = mapped_column(Float, index=True)
    center_lng: Mapped[float] = mapped_column(Float, index=True)

    roughness_score: Mapped[float] = mapped_column(Float, default=0.0)
    severity_class: Mapped[str] = mapped_column(String, default="smooth")
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    defect_probability: Mapped[float] = mapped_column(Float, default=0.0)

    trend: Mapped[str] = mapped_column(String, default="stable")  # worsening|improving|stable

    # --- Bayesian pothole model (hit + swerve fusion) ---
    pothole_probability: Mapped[float] = mapped_column(Float, default=0.0)
    ex_log_odds: Mapped[float] = mapped_column(Float, default=0.0)  # existence log-odds
    intensity_score: Mapped[float] = mapped_column(Float, default=0.0)  # fused severity
    intensity_mean: Mapped[float] = mapped_column(Float, default=0.0)   # mean hit magnitude
    intensity_var: Mapped[float] = mapped_column(Float, default=0.0)
    intensity_class: Mapped[str] = mapped_column(String, default="none")  # none|minor|medium|large
    swerve_rate: Mapped[float] = mapped_column(Float, default=0.0)
    n_hits: Mapped[float] = mapped_column(Float, default=0.0)
    n_swerves: Mapped[float] = mapped_column(Float, default=0.0)
    n_clears: Mapped[float] = mapped_column(Float, default=0.0)
    loc_lat: Mapped[float] = mapped_column(Float, default=0.0)   # refined location estimate
    loc_lng: Mapped[float] = mapped_column(Float, default=0.0)
    loc_var_m2: Mapped[float] = mapped_column(Float, default=0.0)  # location spread (m^2)
    loc_weight: Mapped[float] = mapped_column(Float, default=0.0)

    alpha: Mapped[float] = mapped_column(Float, default=1.0)
    beta: Mapped[float] = mapped_column(Float, default=1.0)
    mean: Mapped[float] = mapped_column(Float, default=0.0)
    m2: Mapped[float] = mapped_column(Float, default=0.0)
    n_eff: Mapped[float] = mapped_column(Float, default=0.0)
    trend_ema: Mapped[float] = mapped_column(Float, default=0.0)
    n_passes: Mapped[int] = mapped_column(Integer, default=0)
    n_devices: Mapped[int] = mapped_column(Integer, default=0)

    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
