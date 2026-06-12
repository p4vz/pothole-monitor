// Collector configuration. Point API_BASE at your deployed backend.
export const CONFIG = {
  API_BASE: "http://127.0.0.1:8000",

  // Sensor sampling — see plan: 50 Hz is the sweet spot for road-anomaly detection.
  IMU_RATE_HZ: 50,
  GPS_INTERVAL_MS: 1000, // 1 Hz fused location

  // Batching: close + upload every BATCH_SECONDS (1–5 min per the design).
  BATCH_SECONDS: 300,

  // Upload retry (exponential backoff, capped).
  UPLOAD_RETRY_BASE_MS: 2000,
  UPLOAD_MAX_RETRIES: 5,

  // Privacy: drop the first/last N metres of every trip (home/work obfuscation).
  TRIP_TRIM_METERS: 100,
};
