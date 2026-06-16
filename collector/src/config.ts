// Collector configuration. Point API_BASE at your deployed backend.
export const CONFIG = {
  API_BASE: "https://pothole-monitor-production.up.railway.app",

  // Sensor sampling — see plan: 50 Hz is the sweet spot for road-anomaly detection.
  IMU_RATE_HZ: 50,
  GPS_INTERVAL_MS: 1000, // 1 Hz fused location

  // --- Automatic drive detection (battery-optimised) ---
  DRIVE_SPEED_MPS: 5.0,     // ~18 km/h sustained => driving
  DRIVE_CONFIRM_MS: 20000,  // must hold for 20 s before capture starts (no false starts)
  STOP_SPEED_MPS: 1.5,      // below this counts as stopped
  STOP_GRACE_MS: 120000,    // stopped for 2 min => end the trip
  DETECT_DISTANCE_M: 60,    // idle detection: wake ~every 60 m of movement (low power)
  DETECT_DEFER_MS: 30000,   // batch idle location wakeups to save battery

  // Batching: close + upload every BATCH_SECONDS (1–5 min per the design).
  BATCH_SECONDS: 300,

  // Upload retry (exponential backoff, capped).
  UPLOAD_RETRY_BASE_MS: 2000,
  UPLOAD_MAX_RETRIES: 5,

  // Privacy: drop the first/last N metres of every trip (home/work obfuscation).
  TRIP_TRIM_METERS: 100,
};
