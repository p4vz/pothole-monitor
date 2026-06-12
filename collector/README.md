# RoadSense collector (React Native / Expo)

Logs accelerometer + gyroscope at **50 Hz** and GPS at **1 Hz** into a local
SQLite buffer, closes a batch every few minutes, gzips it, and uploads it to the
backend. Offline-safe (batches queue and retry) and idempotent on `batch_id`.

> **Skeleton.** This is the core data path, not a store-ready app. It needs an
> **Expo dev build** (not Expo Go) for high-rate sensors and background logging.

## Data path

```
Recorder (sensors.ts) ──50 Hz IMU + 1 Hz GPS──▶ in-memory batch
        every CONFIG.BATCH_SECONDS ─ flush ─▶ SQLite (buffer.ts)
                                 onFlush ─▶ drain() (uploader.ts)
                                              gzip + POST /v1/batches
                                              delete locally on ack
```

## Run

```bash
cd collector
npm install
# set CONFIG.API_BASE in src/config.ts to your backend
npx expo run:android   # or run:ios — a dev build, not Expo Go
```

## Background logging caveats

Sustained high-rate IMU in the background is OS-restricted. The design is an
explicit **trip** the user starts/stops:

- **Android** — foreground service (`FOREGROUND_SERVICE_LOCATION`,
  `HIGH_SAMPLING_RATE_SENSORS`) keeps sensors alive with the screen off.
- **iOS** — `UIBackgroundModes: location` keeps the app live during a trip;
  Apple restricts silent always-on motion, so logging is tied to an active trip.

## Privacy

`CONFIG.TRIP_TRIM_METERS` reserves trimming the first/last ~100 m of each trip
(home/work obfuscation). Device IDs are anonymous; tokens are stored locally.

## Files

| File | Role |
|------|------|
| `src/config.ts` | rates, batch window, retry, API base |
| `src/sensors.ts` | `Recorder` — IMU/GPS capture + batch flush |
| `src/buffer.ts` | SQLite batch queue (survives app kill) |
| `src/uploader.ts` | gzip + upload + backoff retry, ack-then-delete |
| `src/api.ts` | anonymous device registration + token cache |
| `App.tsx` | start/stop trip UI + live status |
