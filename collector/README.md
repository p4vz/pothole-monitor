# RoadSense collector (React Native / Expo) — Android

A lightweight **Android** app that **detects when you're driving and notifies
you** to start mapping road conditions. It never auto-starts: only the user
knows whether the phone is mounted in its holder, so capturing begins when they
tap the notification (an unmounted phone in a pocket would otherwise record
garbage). Logs accelerometer + gyroscope at **50 Hz** and GPS at **1 Hz**,
buffers locally, gzips, and uploads. Offline-safe and idempotent on `batch_id`.

> iOS is deferred for now. Needs an **Expo dev/EAS build** (not Expo Go) for
> high-rate sensors and background tasks. A Play Store listing needs a Google
> Play developer account ($25 one-off) — or distribute the APK directly.

## Drive detection → notify → confirm (battery strategy)

```
idle ──low-power background location (Balanced, wake ~every 60 m)
        speed ≥ DRIVE_SPEED_MPS for DRIVE_CONFIRM_MS
          └─▶ NOTIFY "Driving detected — mount your phone & tap to start"
   user taps (phone now mounted)
          └─▶ upgrade GPS to navigation accuracy + start 50 Hz IMU (driveDetect.ts)
capturing ──50 Hz IMU + 1 Hz GPS──▶ batch ─every BATCH_SECONDS▶ SQLite ─▶ upload
        stopped < STOP_SPEED_MPS for STOP_GRACE_MS
          └─▶ end trip, upload, drop back to low-power detection
```

Detection is battery-light (deferred low-power location); the 50 Hz sensors run
**only after the user confirms** and stops at trip end. All thresholds live in
`src/config.ts`. A **manual trip** button remains for one-off recordings.

## Run

```bash
cd collector
npm install
# API_BASE in src/config.ts already points at the deployed backend
npx expo run:android   # or run:ios — a dev build, not Expo Go
```

## Background logging caveats (Android)

A foreground service (`FOREGROUND_SERVICE_LOCATION`, `HIGH_SAMPLING_RATE_SENSORS`)
plus background location keeps capture alive with the screen off;
`ACTIVITY_RECOGNITION` aids vehicle detection. A force-killed app resumes
low-power GPS detection (and re-notifies on the next drive); the 50 Hz IMU
resumes once the user taps to confirm again.

## Build the Android app (one command)

```bash
cd collector
npm install
npx eas-cli login          # first time only (free Expo account)
npx eas-cli build:configure # first time only — creates the EAS project id
npm run build:android      # => installable APK (preview profile); EAS prints a download URL
```

`npm run build:android` runs `eas build -p android --profile preview` and
produces a sideloadable **APK** with a shareable link. For the Play Store use
`npm run build:android:prod` (AAB) then `npm run submit:android`. Profiles live
in `eas.json`.

## Publish + link from the website

Put the APK / Play Store URL from the build into the website's
`backend/web/config.js` (`APP_ANDROID_URL`) — the "Get the Android app" button
on the collector page lights up automatically.

## Privacy

`CONFIG.TRIP_TRIM_METERS` reserves trimming the first/last ~100 m of each trip
(home/work obfuscation). Device IDs are anonymous; tokens are stored locally.

## Files

| File | Role |
|------|------|
| `src/config.ts` | rates, drive-detection thresholds, batch window, retry, API base |
| `src/driveDetect.ts` | background location task: detect driving, **notify**, start capture on tap |
| `src/sensors.ts` | `Recorder` — IMU capture (+ optional GPS) + batch flush |
| `src/buffer.ts` | SQLite batch queue (survives app kill) |
| `src/uploader.ts` | gzip + upload + backoff retry; gated by the Wi-Fi-only setting |
| `src/settings.ts` | persisted user settings (Wi-Fi-only) |
| `src/api.ts` | anonymous device registration + token cache |
| `App.tsx` | drive-detection + Wi-Fi-only toggles, manual trip, live status |

## Upload on Wi-Fi only

Toggle **"Upload on Wi-Fi only"** to hold batches during the drive (queued in
SQLite) and sync once at the **end of the trip**, and only when on Wi-Fi —
saving cellular data and radio battery. The uploader checks `expo-network`
before draining; anything held back flushes the next time the app is foregrounded
on Wi-Fi (or the next drive that ends on Wi-Fi). With the toggle off (default),
each batch uploads as it closes.
