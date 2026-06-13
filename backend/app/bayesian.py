"""Bayesian pothole inference: fuse 'hit' and 'swerve' evidence across passes.

A large pothole produces two driver behaviours over repeat passes:
  * HIT   — a driver drives over it: a vertical jerk (the classic signal).
  * SWERVE — a driver steers around it: an out-and-back yaw transient and/or a
             lateral-acceleration excursion, with little or no vertical jerk.

Counting only hits underestimates avoidable potholes (the ones most people steer
around). This module classifies each pass as hit / swerve / clear and fuses them:

  * Existence — accumulate log-odds via per-class likelihood ratios (hits and
    swerves both raise P(pothole); clears lower it), with recency decay.
  * Intensity — a recency-decayed posterior over hit magnitude, inflated by the
    swerve rate (everyone avoids it + big jerks when hit => large).
  * Location — a quality-weighted 2D mean of hit/swerve positions (hits weighted
    higher because they localise the defect precisely), giving a sub-cell estimate.
"""
from __future__ import annotations

import math

from .analysis import Observation
from .config import settings

HIT, SWERVE, CLEAR = "hit", "swerve", "clear"


def classify_pass(obs: Observation, cfg=settings) -> tuple[str, float]:
    """Return (class, hit_magnitude). A swerve needs yaw in BOTH directions
    (steer out and back) or a strong lateral excursion, and no vertical hit —
    which separates evasive maneuvers from steady turns (one-directional yaw)."""
    is_hit = obs.event_count > 0 or obs.vert_peak >= cfg.event_peak_thresh
    if is_hit:
        return HIT, obs.vert_peak
    swerve_yaw = min(obs.yaw_out, obs.yaw_back)  # large only if both directions present
    if swerve_yaw >= cfg.swerve_yaw_thresh or obs.lateral_rms >= cfg.swerve_lat_thresh:
        return SWERVE, 0.0
    return CLEAR, 0.0


def _llr(klass: str, cfg=settings) -> float:
    """Log-likelihood ratio log P(obs|pothole)/P(obs|no pothole) for the class."""
    table = {
        HIT: (cfg.p_hit_given_pothole, cfg.p_hit_given_none),
        SWERVE: (cfg.p_swerve_given_pothole, cfg.p_swerve_given_none),
        CLEAR: (cfg.p_clear_given_pothole, cfg.p_clear_given_none),
    }
    p_h, p_n = table[klass]
    return math.log(p_h / p_n)


def intensity_class(score: float, cfg=settings) -> str:
    if score < cfg.event_peak_thresh:
        return "none"
    if score < cfg.intensity_minor_max:
        return "minor"
    if score < cfg.intensity_medium_max:
        return "medium"
    return "large"


def _meters_per_deg(lat: float) -> tuple[float, float]:
    return 111_111.0, 111_111.0 * math.cos(math.radians(lat))


def init_state(state, obs: Observation, cfg=settings) -> None:
    """Seed the Bayesian fields with the prior on a freshly-created segment."""
    state.ex_log_odds = math.log(cfg.pothole_prior / (1.0 - cfg.pothole_prior))
    state.pothole_probability = cfg.pothole_prior
    state.intensity_mean = 0.0
    state.intensity_var = 0.0
    state.intensity_score = 0.0
    state.intensity_class = "none"
    state.swerve_rate = 0.0
    state.n_hits = 0.0
    state.n_swerves = 0.0
    state.n_clears = 0.0
    state.loc_lat = obs.centroid_lat
    state.loc_lng = obs.centroid_lng
    state.loc_var_m2 = 0.0
    state.loc_weight = 0.0


def update(state, obs: Observation, decay: float, cfg=settings) -> None:
    """Fold one pass into the Bayesian fields. `decay` in [0,1] is the recency
    factor already computed from the time since last update (1 = no decay)."""
    klass, hit_mag = classify_pass(obs, cfg)
    w = max(0.0, min(1.0, obs.quality))

    # --- existence: decay the evidence accumulated beyond the prior, then add ---
    prior_lo = math.log(cfg.pothole_prior / (1.0 - cfg.pothole_prior))
    state.ex_log_odds = prior_lo + (state.ex_log_odds - prior_lo) * decay + w * _llr(klass, cfg)
    state.pothole_probability = 1.0 / (1.0 + math.exp(-state.ex_log_odds))

    # --- decay the running counts so rates and intensity heal over time ---
    state.n_hits *= decay
    state.n_swerves *= decay
    state.n_clears *= decay
    state.intensity_var *= decay
    state.loc_weight *= decay

    if klass == HIT:
        # Decayed-mean update of hit magnitude (Welford-style on decayed counts).
        n_new = state.n_hits + w
        if n_new > 0:
            delta = hit_mag - state.intensity_mean
            state.intensity_mean += delta * (w / n_new)
            state.intensity_var += w * delta * (hit_mag - state.intensity_mean)
        state.n_hits = n_new
    elif klass == SWERVE:
        state.n_swerves += w
    else:
        state.n_clears += w

    aware = state.n_hits + state.n_swerves
    state.swerve_rate = float(state.n_swerves / aware) if aware > 0 else 0.0

    # --- intensity: hit magnitude inflated by how many drivers avoid it ---
    base = state.intensity_mean
    if state.n_hits < 0.5 and state.n_swerves > 0:
        # Avoided by everyone with no clean hit sample — infer from evasion alone.
        base = cfg.event_peak_thresh
    state.intensity_score = float(base * (1.0 + cfg.swerve_intensity_boost * state.swerve_rate))
    state.intensity_class = intensity_class(state.intensity_score, cfg)

    # --- location: quality-weighted running mean; hits localise better ---
    loc_w = w * (1.0 if klass == HIT else cfg.swerve_loc_weight if klass == SWERVE else 0.0)
    if loc_w > 0:
        tot = state.loc_weight + loc_w
        m_lat, m_lng = _meters_per_deg(state.loc_lat or obs.centroid_lat)
        dlat = obs.centroid_lat - state.loc_lat
        dlng = obs.centroid_lng - state.loc_lng
        state.loc_lat += dlat * (loc_w / tot)
        state.loc_lng += dlng * (loc_w / tot)
        # Track spread in metres^2 around the running mean.
        dist2 = (dlat * m_lat) ** 2 + (dlng * m_lng) ** 2
        state.loc_var_m2 = (state.loc_var_m2 * state.loc_weight + loc_w * dist2) / tot
        state.loc_weight = tot
