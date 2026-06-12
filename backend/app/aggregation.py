"""Aggregation: fold each per-pass observation into the segment's running state.

Design goals from the spec:
  * combine repeated passes (same person) AND passes by different people;
  * single-pass outliers stay low-confidence, agreement raises confidence;
  * distinct devices raise confidence faster than one device repeating;
  * roads HEAL — old rough observations decay so a repaved road goes smooth.

Roughness is a recency-decayed running mean (capped effective-sample EWMA, so it
stays adaptive). "A defect exists here" is a Beta(alpha, beta) posterior: a
detected pass adds to alpha, a clean pass to beta, both decayed by recency.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .analysis import Observation
from .config import settings
from .models import SegmentObservation, SegmentState
from . import segmentation as seg


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def severity_class(roughness: float, cfg=settings) -> str:
    if roughness <= cfg.severity_smooth_max:
        return "smooth"
    if roughness <= cfg.severity_minor_max:
        return "minor"
    if roughness <= cfg.severity_rough_max:
        return "rough"
    return "severe"


def _confidence(alpha: float, beta: float, n_devices: int, cfg=settings) -> float:
    """Evidence-based confidence, attenuated when few distinct devices.

    Concentration above the Beta(1,1) prior measures accumulated evidence; the
    device factor caps confidence at 0.5 for a single device and rises with each
    additional independent device.
    """
    concentration = max(0.0, alpha + beta - 2.0)
    base = concentration / (concentration + cfg.confidence_k)
    device_factor = n_devices / (n_devices + 1.0) if n_devices > 0 else 0.0
    return float(base * device_factor)


def fold(session: Session, obs: Observation, device_id: str, now: datetime, cfg=settings) -> SegmentState:
    now = _aware(now)
    state = session.get(SegmentState, obs.segment_key)
    detection = obs.event_count > 0 or obs.roughness >= cfg.defect_roughness_thresh
    weight = max(0.0, min(1.0, obs.quality))

    if state is None:
        lat, lng = seg.cell_center(obs.h3_index)
        state = SegmentState(
            segment_key=obs.segment_key,
            h3_index=obs.h3_index,
            heading_bucket=obs.heading_bucket,
            center_lat=lat,
            center_lng=lng,
            alpha=1.0,
            beta=1.0,
            mean=obs.roughness,
            m2=0.0,
            n_eff=1.0,
            n_passes=0,
            n_devices=0,
            first_seen=now,
        )
        session.add(state)
    else:
        # Recency decay since last update (repaving / seasonal healing).
        dt_days = max(0.0, (now - _aware(state.last_seen)).total_seconds() / 86400.0)
        d = 0.5 ** (dt_days / cfg.decay_halflife_days)
        state.alpha = 1.0 + (state.alpha - 1.0) * d
        state.beta = 1.0 + (state.beta - 1.0) * d
        state.n_eff *= d
        state.m2 *= d

        # Decayed-EWMA update of the running roughness mean.
        n_eff_new = min(state.n_eff + 1.0, cfg.n_eff_cap)
        delta = obs.roughness - state.mean
        state.mean += delta * (1.0 / n_eff_new)
        state.m2 += delta * (obs.roughness - state.mean)
        state.n_eff = n_eff_new

    # Beta update over "defect exists".
    if detection:
        state.alpha += weight
    else:
        state.beta += weight

    state.n_passes += 1
    state.n_devices = int(
        session.execute(
            select(func.count(func.distinct(SegmentObservation.device_id))).where(
                SegmentObservation.segment_key == obs.segment_key
            )
        ).scalar_one()
    )

    state.roughness_score = float(state.mean)
    state.severity_class = severity_class(state.mean, cfg)
    state.defect_probability = float(state.alpha / (state.alpha + state.beta))
    state.confidence = _confidence(state.alpha, state.beta, state.n_devices, cfg)
    state.last_seen = now
    state.updated_at = now
    return state
