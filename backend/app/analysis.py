"""Heuristic analysis pipeline (v1).

Raw batch -> per-segment observations:
  1. time-align GPS (1 Hz) onto IMU timestamps (50 Hz)
  2. reorient: estimate gravity (low-pass), remove it, project to road-normal axis
  3. quality-gate: drop idle / over-speed / poor-GPS samples
  4. window the vertical linear acceleration
  5. per-window features: roughness (RMS), peak, defect events
  6. map each window to an H3 segment and collapse windows -> one observation
     per (segment, pass)

Pure NumPy, no I/O — directly unit-testable with synthetic signals. A supervised
ML model is a planned upgrade that can consume the same window features.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import settings
from . import segmentation as seg


@dataclass
class Observation:
    segment_key: str
    h3_index: str
    heading_bucket: int
    ts: float
    roughness: float
    event_count: int
    max_severity: int
    mean_speed: float
    quality: float
    centroid_lat: float
    centroid_lng: float


@dataclass
class WindowFeat:
    """Per-window features — the shared unit for the heuristic and the ML model."""

    ts: float
    lat: float
    lng: float
    heading: float
    quality: float
    rms: float
    peak: float
    peak_count: int
    p2p: float
    mean_speed: float
    event_count: int
    max_severity: int

    def vector(self) -> list[float]:
        """Feature vector for ML (order matches ml.FEATURE_NAMES)."""
        return [self.rms, self.peak, float(self.peak_count), self.p2p, self.mean_speed]


def _moving_average(x: np.ndarray, n: int) -> np.ndarray:
    """Centered moving average along axis 0, edge-corrected (per column)."""
    if n <= 1:
        return x.astype(float)
    kernel = np.ones(n)
    if x.ndim == 1:
        num = np.convolve(x, kernel, mode="same")
        den = np.convolve(np.ones_like(x, dtype=float), kernel, mode="same")
        return num / den
    out = np.empty_like(x, dtype=float)
    den = np.convolve(np.ones(x.shape[0], dtype=float), kernel, mode="same")
    for c in range(x.shape[1]):
        out[:, c] = np.convolve(x[:, c], kernel, mode="same") / den
    return out


def _interp(t: np.ndarray, gt: np.ndarray, gv: np.ndarray) -> np.ndarray:
    if gt.size == 0:
        return np.full_like(t, np.nan)
    if gt.size == 1:
        return np.full_like(t, gv[0])
    return np.interp(t, gt, gv)


def _interp_heading(t: np.ndarray, gt: np.ndarray, gh: np.ndarray) -> np.ndarray:
    """Circular interpolation of heading in degrees via sin/cos."""
    rad = np.radians(gh)
    s = _interp(t, gt, np.sin(rad))
    c = _interp(t, gt, np.cos(rad))
    return np.degrees(np.arctan2(s, c)) % 360.0


def _circular_mean_deg(deg: np.ndarray) -> float:
    rad = np.radians(deg)
    return float(np.degrees(np.arctan2(np.sin(rad).mean(), np.cos(rad).mean())) % 360.0)


def _cumulative_meters(lat: np.ndarray, lng: np.ndarray) -> np.ndarray:
    """Cumulative great-circle distance (m) along the track, per sample."""
    latr = np.radians(lat)
    lngr = np.radians(lng)
    dlat = np.diff(latr)
    dlng = np.diff(lngr)
    a = np.sin(dlat / 2) ** 2 + np.cos(latr[:-1]) * np.cos(latr[1:]) * np.sin(dlng / 2) ** 2
    seg = 6_371_000.0 * 2 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))
    return np.concatenate([[0.0], np.cumsum(seg)])


def severity_from_peak(peak: float, cfg=settings) -> int:
    """0 none, 1 small, 2 medium, 3 large — from linear-vertical peak (m/s^2)."""
    if peak < cfg.event_peak_thresh:
        return 0
    if peak < 2 * cfg.event_peak_thresh:
        return 1
    if peak < 4 * cfg.event_peak_thresh:
        return 2
    return 3


def _count_events(v: np.ndarray, thresh: float) -> tuple[int, int]:
    """Count local maxima of |v| above thresh; return (count, max_severity)."""
    a = np.abs(v)
    count = 0
    max_sev = 0
    for i in range(1, len(a) - 1):
        if a[i] >= thresh and a[i] >= a[i - 1] and a[i] > a[i + 1]:
            count += 1
            max_sev = max(max_sev, severity_from_peak(a[i]))
    return count, max_sev


def compute_windows(payload: dict, cfg=settings) -> list[WindowFeat]:
    """Align, reorient, gate, and window a raw batch into per-window features.

    Shared by the heuristic aggregation path and the ML training/inference path.
    Includes low-quality windows (with their `quality`) so callers can filter.
    """
    imu = payload.get("imu", {})
    gps = payload.get("gps", [])
    t = np.asarray(imu.get("t", []), dtype=float)
    if t.size < 4:
        return []

    a = np.stack(
        [
            np.asarray(imu["ax"], float),
            np.asarray(imu["ay"], float),
            np.asarray(imu["az"], float),
        ],
        axis=1,
    )

    dt = float(np.median(np.diff(t)))
    fs = (1.0 / dt) if dt > 0 else float(cfg.sample_rate_default)

    # --- align GPS onto IMU clock ---
    gt = np.asarray([g["t"] for g in gps], float)
    lat = _interp(t, gt, np.asarray([g["lat"] for g in gps], float))
    lng = _interp(t, gt, np.asarray([g["lng"] for g in gps], float))
    speed = _interp(t, gt, np.asarray([g.get("speed", np.nan) for g in gps], float))
    heading = _interp_heading(t, gt, np.asarray([g.get("heading", 0.0) for g in gps], float))
    acc = _interp(t, gt, np.asarray([g.get("acc", 0.0) for g in gps], float))

    # --- reorient: gravity via low-pass, remove it, project onto road-normal ---
    n_lp = max(1, int(cfg.gravity_lp_seconds * fs))
    grav = _moving_average(a, n_lp)
    gnorm = np.linalg.norm(grav, axis=1, keepdims=True)
    gnorm = np.where(gnorm < 1e-6, 1e-6, gnorm)
    ghat = grav / gnorm
    linear = a - grav
    vert = np.sum(linear * ghat, axis=1)  # vertical (road-normal) linear acceleration

    # --- quality gate ---
    good = (
        (speed >= cfg.min_speed_mps)
        & (speed <= cfg.max_speed_mps)
        & (np.nan_to_num(acc, nan=0.0) <= cfg.max_gps_acc_m)
        & np.isfinite(lat)
        & np.isfinite(lng)
    )

    # Privacy backstop: drop the first/last N metres of the trip (home/work).
    if cfg.trip_trim_meters > 0:
        cum = _cumulative_meters(np.nan_to_num(lat), np.nan_to_num(lng))
        total = cum[-1]
        good &= (cum >= cfg.trip_trim_meters) & (cum <= total - cfg.trip_trim_meters)

    # --- window the vertical signal into per-window features ---
    win = max(4, int(cfg.window_seconds * fs))
    hop = max(1, int(win * (1.0 - cfg.window_overlap)))
    windows: list[WindowFeat] = []

    for start in range(0, len(t) - win + 1, hop):
        sl = slice(start, start + win)
        v = vert[sl]
        ev_count, ev_sev = _count_events(v, cfg.event_peak_thresh)
        windows.append(
            WindowFeat(
                ts=float(np.mean(t[sl])),
                lat=float(np.mean(lat[sl])),
                lng=float(np.mean(lng[sl])),
                heading=_circular_mean_deg(heading[sl]),
                quality=float(np.mean(good[sl])),
                rms=float(np.sqrt(np.mean(v**2))),
                peak=float(np.max(np.abs(v))),
                peak_count=ev_count,
                p2p=float(np.max(v) - np.min(v)),
                mean_speed=float(np.nanmean(speed[sl])),
                event_count=ev_count,
                max_severity=ev_sev,
            )
        )
    return windows


def analyze(payload: dict, cfg=settings, scorer=None) -> list[Observation]:
    """Window a batch and collapse windows into one observation per segment/pass.

    If `scorer` is given (an ml.RoughnessModel), it overrides heuristic event
    detection per window; otherwise the heuristic peak-threshold path is used.
    """
    groups: dict[str, dict] = {}
    for w in compute_windows(payload, cfg):
        if w.quality < cfg.min_window_quality:
            continue
        ev_count, ev_sev = w.event_count, w.max_severity
        if scorer is not None:
            ev_count, ev_sev = scorer.score_window(w)
        key, h3idx, bucket = seg.segment_for(w.lat, w.lng, w.heading)
        g = groups.get(key)
        if g is None:
            g = dict(
                h3=h3idx, bucket=bucket, rms=[], events=0, sev=0,
                speed=[], qual=[], lat=[], lng=[], ts=[],
            )
            groups[key] = g
        g["rms"].append(w.rms)
        g["events"] += ev_count
        g["sev"] = max(g["sev"], ev_sev)
        g["speed"].append(w.mean_speed)
        g["qual"].append(w.quality)
        g["lat"].append(w.lat)
        g["lng"].append(w.lng)
        g["ts"].append(w.ts)

    out: list[Observation] = []
    for key, g in groups.items():
        out.append(
            Observation(
                segment_key=key,
                h3_index=g["h3"],
                heading_bucket=g["bucket"],
                ts=float(np.median(g["ts"])),
                roughness=float(np.mean(g["rms"])),
                event_count=int(g["events"]),
                max_severity=int(g["sev"]),
                mean_speed=float(np.nanmean(g["speed"])),
                quality=float(np.mean(g["qual"])),
                centroid_lat=float(np.mean(g["lat"])),
                centroid_lng=float(np.mean(g["lng"])),
            )
        )
    return out
