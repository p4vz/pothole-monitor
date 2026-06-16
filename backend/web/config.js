// Configuration for the RoadSense web collector.
// This page logs raw motion + GPS in the browser and uploads batches to the
// backend API. No GitHub token, no secrets — raw data is archived server-side.
window.CONFIG = {
  // Backend API base URL (where GET /healthz returns ok). Leave "" to use the
  // same origin (works when the API also serves this page). Override at runtime
  // with ?api=https://your-backend.up.railway.app
  API_BASE: "",

  // Motion sampling: browsers fire devicemotion at ~50-60 Hz; we record actual
  // timestamps and the backend derives the true rate, so variable rate is fine.
  // GPS via watchPosition (~1 Hz).
  BATCH_SECONDS: 60,           // close + upload a batch each minute

  // Offline-safe upload retry (exponential backoff).
  UPLOAD_RETRY_BASE_MS: 2000,
  UPLOAD_MAX_RETRIES: 4,

  // Native app store links (shown on the page). Leave "" until published — the
  // button then shows "coming soon". Set to your App Store / Play Store /
  // TestFlight / APK URLs once the builds are live.
  APP_IOS_URL: "",
  APP_ANDROID_URL: "",
};
