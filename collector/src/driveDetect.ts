// Drive detection -> NOTIFY (never auto-start).
//
// The app can't tell whether the phone is mounted in a windscreen holder or
// loose in a pocket/bag, so auto-capturing would record garbage and false
// positives. Instead, when sustained driving is detected we send ONE
// notification; capture only starts when the user taps it (i.e. confirms the
// phone is mounted). Tapping is the explicit "I'm set up, start mapping" signal.
//
// Battery: while watching we run low-power background location only. The 50 Hz
// IMU spins up only after the user confirms, and stops when the trip ends.
import * as TaskManager from "expo-task-manager";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";

import { CONFIG } from "./config";
import { Recorder } from "./sensors";
import { drain } from "./uploader";
import { wifiOnly } from "./settings";

export const DRIVE_TASK = "roadsense-drive-detect";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

let recorder: Recorder | null = null;
let capturing = false;   // 50 Hz recording in progress
let prompted = false;    // notification sent for the current drive, awaiting tap
let aboveSince = 0;
let belowSince = 0;
const listeners = new Set<(capturing: boolean) => void>();

export function onCaptureStateChange(cb: (capturing: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function emit() {
  for (const cb of listeners) cb(capturing);
}

async function setLocationMode(mode: "detect" | "capture") {
  const opts: Location.LocationTaskOptions =
    mode === "capture"
      ? { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 0, timeInterval: CONFIG.GPS_INTERVAL_MS }
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
      notificationBody: mode === "capture" ? "Capturing road condition…" : "Watching for drives.",
    },
  });
}

// Detected driving -> prompt the user to confirm the phone is mounted.
async function promptToCapture() {
  prompted = true;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Driving detected",
        body: "Mounted your phone? Tap to start mapping road conditions.",
        data: { action: "start-capture" },
      },
      trigger: null,
    });
  } catch {
    /* notifications optional */
  }
}

// Called when the user taps the notification (confirms mounted) or taps "start".
export async function startCaptureConfirmed() {
  if (capturing) return;
  capturing = true;
  emit();
  await setLocationMode("capture"); // upgrade GPS to navigation accuracy
  recorder = new Recorder();
  recorder.onFlush = () => {
    if (!wifiOnly()) drain(); // Wi-Fi-only: hold until trip end
  };
  await recorder.start({ withGps: false }); // GPS arrives via the background task
}

async function endCapture() {
  if (!capturing) return;
  capturing = false;
  emit();
  await recorder?.stop();
  recorder = null;
  drain();
  await setLocationMode("detect");
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title: "Trip saved", body: "Road data uploaded — thanks for contributing." },
      trigger: null,
    });
  } catch {
    /* optional */
  }
}

// Tapping the notification starts capture (registered once, app-wide).
Notifications.addNotificationResponseReceivedListener((resp) => {
  if (resp.notification.request.content.data?.action === "start-capture") {
    startCaptureConfirmed();
  }
});

// Background location task: fed fixes by the OS even when backgrounded.
TaskManager.defineTask(DRIVE_TASK, async ({ data, error }) => {
  if (error) return;
  const locs = (data as { locations?: Location.LocationObject[] })?.locations;
  if (!locs?.length) return;
  const now = Date.now();
  for (const loc of locs) {
    if (capturing) recorder?.addGps(loc); // feed the active trip
    const speed = loc.coords.speed ?? 0;
    if (speed >= CONFIG.DRIVE_SPEED_MPS) {
      belowSince = 0;
      if (!aboveSince) aboveSince = now;
      // Sustained driving -> notify once (only the user knows if it's mounted).
      if (!capturing && !prompted && now - aboveSince >= CONFIG.DRIVE_CONFIRM_MS) {
        await promptToCapture();
      }
    } else {
      aboveSince = 0;
      if (!belowSince) belowSince = now;
      if (now - belowSince >= CONFIG.STOP_GRACE_MS) {
        if (capturing) await endCapture();
        prompted = false; // a new drive will prompt again
      }
    }
  }
});

export async function enableDriveDetection(): Promise<boolean> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") return false;
  await Location.requestBackgroundPermissionsAsync();
  await Notifications.requestPermissionsAsync();
  if (!(await Location.hasStartedLocationUpdatesAsync(DRIVE_TASK))) {
    await setLocationMode("detect");
  }
  return true;
}

export async function disableDriveDetection(): Promise<void> {
  if (capturing) await endCapture();
  prompted = false;
  if (await Location.hasStartedLocationUpdatesAsync(DRIVE_TASK)) {
    await Location.stopLocationUpdatesAsync(DRIVE_TASK);
  }
}

export async function isDriveDetectionEnabled(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(DRIVE_TASK);
}

export function isCapturing(): boolean {
  return capturing;
}

// Manual "stop capture" from the UI.
export async function stopCapture(): Promise<void> {
  await endCapture();
}
