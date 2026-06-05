// Configuration for the Pavement Holes (pothole) reporter.
// NOTE: The Google Maps key is client-visible by nature — restrict it by HTTP
// referrer (your GitHub Pages domain) and to the Maps JavaScript API in the
// Google Cloud Console. The GitHub token is NEVER stored here; it is entered at
// runtime and kept only in your browser's localStorage.
window.CONFIG = {
  // --- Google Maps ---
  MAPS_API_KEY: "AIzaSyBpgX1Ce6PtJGiDAKwLXJgGTYoahFKFREw",

  // --- GitHub "database" (a JSON file committed to this repo) ---
  REPO_OWNER: "p4vz",
  REPO_NAME: "test",
  DATA_PATH: "potholes.json",
  // Branch the live site reads/writes. Use the GitHub Pages branch in
  // production (the old app used "master"); point at the feature branch for
  // pre-merge testing.
  TARGET_BRANCH: "claude/pavement-holes-app-plan-QZKxQ",

  // --- Detection tunables ---
  // Jolt magnitude (m/s^2, deviation from the gravity baseline) above which a
  // pothole is registered in driving mode.
  JOLT_THRESHOLD: 6.0,
  // Peak-jolt cutoffs (m/s^2) mapping a measured jolt to a severity bucket.
  SEVERITY_CUTOFFS: { medium: 9.0, large: 14.0 }, // < medium => small
  // Minimum spacing between auto-detections so one pothole => one report.
  DETECTION_COOLDOWN_MS: 1800,
  // Ignore jolts below this speed (m/s) so parking/idle bumps are not logged.
  MIN_SPEED_MPS: 2.0, // ~7.2 km/h
  // Batch flushing of buffered auto-detections to GitHub.
  BATCH_FLUSH_MS: 30000,
  BATCH_FLUSH_COUNT: 5,
};
