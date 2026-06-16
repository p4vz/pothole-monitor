// Automatic drive detection + background capture.
//
// Battery strategy: while idle we run *low-power* background location only
// (Balanced accuracy, wakes roughly every DETECT_DISTANCE_M of movement). When
// sustained driving speed is seen we (1) post a local notification, (2) switch
// location to navigation accuracy, and (3) start the 50 Hz IMU recorder. When
// the vehicle has been stopped for STOP_GRACE_MS we end the trip, upload, and
// drop back to low-power detection. High-drain sensors run only while actually
// driving.
//
// Limitation: sustained background IMU needs the app process alive. The
// background-location mode (iOS) / foreground service (Android) keeps it alive
// across a normal trip, but a force-killed app only resumes GPS (no IMU) until
// reopened. Fully kill-proof IMU needs a custom native module — see README.
import * as TaskManager from "expo-task-manager";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";

import { CONFIG } from "./config";
import { Recorder } from "./sensors";
import { drain } from "./uploader";

export const DRIVE_TASK = "roadsense-drive-detect";

// Show notifications even when the app is foregrounded.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// Module-level singletons: the background task and the UI share this state while
// the JS context is alive.
let recorder: Recorder | null = null;
let driving = false;
let aboveSince = 0;
let belowSince = 0;
const listeners = new Set<(d: boolean) => void>();

export function onDriveStateChange(cb: (driving: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function emit() {
  for (const cb of listeners) cb(driving);
}

async function notify(title: string, body: string) {
  try {
    await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
  } catch {
    /* notifications optional */
  }
}

async function setLocationMode(mode: "detect" | "drive") {
  const opts: Location.LocationTaskOptions =
    mode === "drive"
      ? {
          accuracy: Location.Accuracy.BestForNavigation,
          distanceInterval: 0,
          timeInterval: CONFIG.GPS_INTERVAL_MS,
        }
      : {
          accuracy: Location.Accuracy.Balanced,
          distanceInterval: CONFIG.DETECT_DISTANCE_M,
          deferredUpdatesInterval: CONFIG.DETECT_DEFER_MS,
          pausesUpdatesAutomatically: true,
        };
  await Location.startLocationUpdatesAsync(DRIVE_TASK, {
    ...opts,
    activityType: Location.ActivityType.AutomotiveNavigation,
    showsBackgroundLocationIndicator: false,
    foregroundService: {
      notificationTitle: "RoadSense",
      notificationBody:
        mode === "drive" ? "Capturing road condition…" : "Watching for drives.",
    },
  });
}

async function startDriving() {
  if (driving) return;
  driving = true;
  emit();
  await notify("Drive detected", "Capturing road condition in the background.");
  await setLocationMode("drive"); // upgrade GPS accuracy while moving
  recorder = new Recorder();
  recorder.onFlush = () => drain();
  await recorder.start({ withGps: false }); // GPS arrives via the background task
}

async function stopDriving() {
  if (!driving) return;
  driving = false;
  emit();
  await recorder?.stop();
  recorder = null;
  drain();
  await setLocationMode("detect"); // back to low power
  await notify("Trip saved", "Road data uploaded — thanks for contributing.");
}

// The background location task: fed GPS fixes by the OS even when backgrounded.
TaskManager.defineTask(DRIVE_TASK, async ({ data, error }) => {
  if (error) return;
  const locs = (data as { locations?: Location.LocationObject[] })?.locations;
  if (!locs?.length) return;
  const now = Date.now();
  for (const loc of locs) {
    recorder?.addGps(loc); // feed the active trip
    const speed = loc.coords.speed ?? 0;
    if (speed >= CONFIG.DRIVE_SPEED_MPS) {
      belowSince = 0;
      if (!aboveSince) aboveSince = now;
      if (!driving && now - aboveSince >= CONFIG.DRIVE_CONFIRM_MS) await startDriving();
    } else {
      aboveSince = 0;
      if (driving) {
        if (!belowSince) belowSince = now;
        if (now - belowSince >= CONFIG.STOP_GRACE_MS) await stopDriving();
      }
    }
  }
});

export async function enableAutoCapture(): Promise<boolean> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") return false;
  await Location.requestBackgroundPermissionsAsync(); // "Always" for background trips
  await Notifications.requestPermissionsAsync();
  if (!(await Location.hasStartedLocationUpdatesAsync(DRIVE_TASK))) {
    await setLocationMode("detect");
  }
  return true;
}

export async function disableAutoCapture(): Promise<void> {
  if (driving) await stopDriving();
  if (await Location.hasStartedLocationUpdatesAsync(DRIVE_TASK)) {
    await Location.stopLocationUpdatesAsync(DRIVE_TASK);
  }
}

export async function isAutoCaptureEnabled(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(DRIVE_TASK);
}

export function isDriving(): boolean {
  return driving;
}
