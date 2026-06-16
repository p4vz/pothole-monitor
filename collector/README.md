# RoadSense collector (React Native / Expo)

A lightweight iOS + Android app that **automatically detects driving** and
captures road data in the **background** — minimal battery, screen off, no need
to open the app. Logs accelerometer + gyroscope at **50 Hz** and GPS at **1 Hz**,
buffers locally, gzips, and uploads to the backend. Offline-safe and idempotent
on `batch_id`.

> Needs an **Expo dev/EAS build** (not Expo Go) for high-rate sensors and
> background tasks. Publishing to the App Store / Play Store needs your own
> Apple ($99/yr) and Google ($25 one-off) developer accounts — see below.

## Automatic drive detection (battery strategy)

```
idle ──low-power background location (Balanced, wake ~every 60 m)
        speed ≥ DRIVE_SPEED_MPS for DRIVE_CONFIRM_MS
          └─▶ notify "Drive detected" + upgrade GPS to navigation accuracy
              + start 50 Hz IMU recorder  (driveDetect.ts)
driving ──50 Hz IMU + 1 Hz GPS──▶ batch ─every BATCH_SECONDS▶ SQLite ─▶ upload
        stopped < STOP_SPEED_MPS for STOP_GRACE_MS
          └─▶ end trip, upload, notify, drop back to low-power detection
```

High-drain sensors run **only while actually moving**; when parked the app uses
cheap, deferred location wakeups to watch for the next drive. All thresholds are
in `src/config.ts`. A **manual trip** button remains for one-off recordings.

## Run

```bash
cd collector
npm install
# API_BASE in src/config.ts already points at the deployed backend
npx expo run:android   # or run:ios — a dev build, not Expo Go
```

## Background logging caveats

- **Android** — a foreground service (`FOREGROUND_SERVICE_LOCATION`,
  `HIGH_SAMPLING_RATE_SENSORS`) plus background location keeps capture alive with
  the screen off; `ACTIVITY_RECOGNITION` aids vehicle detection.
- **iOS** — `UIBackgroundModes: location` keeps the JS context alive across a
  trip so sensors keep sampling. Apple suspends silent always-on motion, so a
  **force-killed** app resumes GPS-only (no IMU) until reopened. Fully
  kill-proof background IMU needs a custom native module (e.g. iOS
  `CMSensorRecorder`) or a library like `react-native-background-geolocation`.

## Publish + link from the website

1. `npm i -g eas-cli && eas login && eas build:configure`
2. `eas build -p ios` / `eas build -p android` → store-ready binaries
   (or `eas submit` to push to TestFlight / Play internal testing).
3. Put the resulting URLs in the website's `backend/web/config.js`
   (`APP_IOS_URL`, `APP_ANDROID_URL`) — the "Get the mobile app" buttons on the
   collector page light up automatically.

## Privacy

`CONFIG.TRIP_TRIM_METERS` reserves trimming the first/last ~100 m of each trip
(home/work obfuscation). Device IDs are anonymous; tokens are stored locally.

## Files

| File | Role |
|------|------|
| `src/config.ts` | rates, drive-detection thresholds, batch window, retry, API base |
| `src/driveDetect.ts` | background location task: detect driving, notify, start/stop capture |
| `src/sensors.ts` | `Recorder` — IMU capture (+ optional GPS) + batch flush |
| `src/buffer.ts` | SQLite batch queue (survives app kill) |
| `src/uploader.ts` | gzip + upload + backoff retry, ack-then-delete |
| `src/api.ts` | anonymous device registration + token cache |
| `App.tsx` | auto-capture toggle + manual trip + live status |
