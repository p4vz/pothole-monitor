"""Pydantic request/response models for the API."""
from __future__ import annotations

from pydantic import BaseModel, Field


class DeviceCreate(BaseModel):
    app_version: str | None = None


class DeviceOut(BaseModel):
    device_id: str
    token: str  # dev: equals device_id. Production: signed JWT.


class GpsSample(BaseModel):
    t: float
    lat: float
    lng: float
    speed: float | None = None
    heading: float | None = None
    acc: float | None = None


class ImuBlock(BaseModel):
    t: list[float]
    ax: list[float]
    ay: list[float]
    az: list[float]
    gx: list[float] | None = None
    gy: list[float] | None = None
    gz: list[float] | None = None
    # Magnetometer (compass) vector, microtesla. Aligned to `t`; entries may be
    # null before the first reading. Archived for future displacement/heading work.
    mx: list[float | None] | None = None
    my: list[float | None] | None = None
    mz: list[float | None] | None = None
    # Device orientation (compass fallback / complement): alpha/beta/gamma degrees
    # (heading / pitch / roll), absolute where the platform provides it.
    oa: list[float | None] | None = None
    ob: list[float | None] | None = None
    og: list[float | None] | None = None


class BatchMeta(BaseModel):
    session_id: str | None = None
    sample_rate: int | None = None
    app_version: str | None = None


class BatchUpload(BaseModel):
    """Client-supplied batch. `batch_id` is the idempotency key (client UUID)."""

    batch_id: str
    meta: BatchMeta = Field(default_factory=BatchMeta)
    imu: ImuBlock
    gps: list[GpsSample] = Field(default_factory=list)


class BatchAck(BaseModel):
    batch_id: str
    status: str
    duplicate: bool = False
