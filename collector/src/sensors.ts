// Sensor recorder: accelerometer + gyroscope at 50 Hz and GPS at 1 Hz into an
// in-memory batch. On each batch close (every CONFIG.BATCH_SECONDS) the columnar
// arrays are flushed to the SQLite buffer and a fresh batch is started.
//
// NOTE: sustained background high-rate IMU is OS-restricted. Drive this from an
// explicit "trip" the user starts/stops, backed by a foreground service
// (Android) / background-location mode (iOS). See app.json + README.
import { Accelerometer, Gyroscope } from "expo-sensors";
import * as Location from "expo-location";

import { CONFIG } from "./config";
import { BatchPayload, GpsSample, saveBatch } from "./buffer";

function newBatchId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class Recorder {
  private sessionId = newBatchId();
  private imu = { t: [] as number[], ax: [] as number[], ay: [] as number[], az: [] as number[], gx: [] as number[], gy: [] as number[], gz: [] as number[] };
  private gps: GpsSample[] = [];
  private lastGyro = { x: 0, y: 0, z: 0 };
  private subs: { remove: () => void }[] = [];
  private gpsSub: Location.LocationSubscription | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  public onFlush?: () => void; // hook the uploader in here

  async start() {
    const intervalMs = 1000 / CONFIG.IMU_RATE_HZ;
    Accelerometer.setUpdateInterval(intervalMs);
    Gyroscope.setUpdateInterval(intervalMs);

    this.subs.push(Gyroscope.addListener((g) => (this.lastGyro = g)));
    this.subs.push(
      Accelerometer.addListener((a) => {
        // expo-sensors reports g-units; convert to m/s^2 for the backend.
        const t = Date.now() / 1000;
        this.imu.t.push(t);
        this.imu.ax.push(a.x * 9.81);
        this.imu.ay.push(a.y * 9.81);
        this.imu.az.push(a.z * 9.81);
        this.imu.gx.push(this.lastGyro.x);
        this.imu.gy.push(this.lastGyro.y);
        this.imu.gz.push(this.lastGyro.z);
      })
    );

    this.gpsSub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: CONFIG.GPS_INTERVAL_MS, distanceInterval: 0 },
      (loc) => {
        this.gps.push({
          t: loc.timestamp / 1000,
          lat: loc.coords.latitude,
          lng: loc.coords.longitude,
          speed: loc.coords.speed ?? 0,
          heading: loc.coords.heading ?? 0,
          acc: loc.coords.accuracy ?? 0,
        });
      }
    );

    this.flushTimer = setInterval(() => this.flush(), CONFIG.BATCH_SECONDS * 1000);
  }

  async flush() {
    if (this.imu.t.length === 0) return;
    const payload: BatchPayload = {
      batch_id: newBatchId(),
      meta: { session_id: this.sessionId, sample_rate: CONFIG.IMU_RATE_HZ },
      imu: this.imu,
      gps: this.gps,
    };
    // Reset buffers for the next window before any await.
    this.imu = { t: [], ax: [], ay: [], az: [], gx: [], gy: [], gz: [] };
    this.gps = [];
    await saveBatch(payload);
    this.onFlush?.();
  }

  async stop() {
    await this.flush();
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    this.gpsSub?.remove();
    if (this.flushTimer) clearInterval(this.flushTimer);
  }

  get sampleCount() {
    return this.imu.t.length;
  }
}
