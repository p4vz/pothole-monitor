"""Configuration. All values overridable via ROADSENSE_* env vars or a .env file."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ROADSENSE_", env_file=".env", extra="ignore"
    )

    # --- Infrastructure (dev defaults run with zero external services) ---
    database_url: str = "sqlite:///./roadsense.db"
    storage_dir: str = "./_storage"

    # CORS: the public read API serves non-sensitive aggregate data, so "*" is
    # fine. Lock to your viewer origin in production if you prefer.
    cors_origins: str = "*"

    # --- Segmentation (H3 hex grid + heading bucket) ---
    h3_resolution: int = 12          # ~3-10 m edge; res 13 for finer lanes
    heading_buckets: int = 8         # split opposite directions / lanes

    # --- Collector defaults (advertised to the app) ---
    sample_rate_default: int = 50    # Hz, accel + gyro

    # --- Analysis pipeline ---
    min_speed_mps: float = 2.8       # ~10 km/h; below this is idle, drop
    max_speed_mps: float = 33.0      # ~120 km/h
    max_gps_acc_m: float = 25.0      # drop windows with poor GPS
    window_seconds: float = 1.0
    window_overlap: float = 0.5
    gravity_lp_seconds: float = 1.0  # low-pass span for gravity estimate
    event_peak_thresh: float = 2.5   # m/s^2 linear-vertical peak => candidate defect
    min_window_quality: float = 0.5  # fraction of good samples to keep a window

    # --- Aggregation ("state of the road") ---
    defect_roughness_thresh: float = 1.2  # roughness above this also counts as a defect
    decay_halflife_days: float = 90.0     # recency decay => roads heal after repaving
    n_eff_cap: float = 30.0               # cap effective sample count => stays adaptive
    confidence_k: float = 4.0             # evidence needed for mid confidence

    # --- Severity bins (roughness score, ~m/s^2 RMS) ---
    severity_smooth_max: float = 0.8
    severity_minor_max: float = 1.6
    severity_rough_max: float = 3.0
    # above severity_rough_max => "severe"


settings = Settings()
