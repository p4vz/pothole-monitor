// RoadSense collector UI (Android).
//  • Drive detection — notifies you when you appear to be driving; tap the
//    notification (once the phone is mounted) to start capturing in the
//    background. Never auto-starts, so an unmounted phone won't record garbage.
//  • Manual trip — start/stop an explicit recording.
import React, { useEffect, useRef, useState } from "react";
import { Text, TouchableOpacity, View, StyleSheet, Switch, AppState } from "react-native";
import * as Location from "expo-location";

import { initBuffer } from "./src/buffer";
import { Recorder } from "./src/sensors";
import { drain } from "./src/uploader";
import { loadSettings, wifiOnly, setWifiOnly } from "./src/settings";
import {
  enableDriveDetection,
  disableDriveDetection,
  isDriveDetectionEnabled,
  onCaptureStateChange,
  stopCapture,
} from "./src/driveDetect";

export default function App() {
  const [detect, setDetect] = useState(false);
  const [wifi, setWifi] = useState(false);
  const [autoCapturing, setAutoCapturing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [samples, setSamples] = useState(0);
  const recorder = useRef<Recorder | null>(null);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    initBuffer().then(drain); // flush anything left from a previous trip
    loadSettings().then((s) => setWifi(s.wifiOnly));
    isDriveDetectionEnabled().then(setDetect);
    const offCapture = onCaptureStateChange(setAutoCapturing);
    // Returning to the app is a good moment to flush queued (Wi-Fi-deferred) batches.
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") drain();
    });
    return () => {
      offCapture();
      sub.remove();
    };
  }, []);

  async function toggleDetect(on: boolean) {
    if (on) {
      setDetect(await enableDriveDetection());
    } else {
      await disableDriveDetection();
      setDetect(false);
      setAutoCapturing(false);
    }
  }

  async function toggleWifi(on: boolean) {
    await setWifiOnly(on);
    setWifi(on);
    if (!on) drain(); // turning it off can release anything held back
  }

  async function toggleManual() {
    if (recording) {
      if (ticker.current) clearInterval(ticker.current);
      await recorder.current?.stop();
      recorder.current = null;
      setRecording(false);
      drain();
      return;
    }
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== "granted") return;
    await Location.requestBackgroundPermissionsAsync();
    const rec = new Recorder();
    rec.onFlush = () => {
      if (!wifiOnly()) drain(); // Wi-Fi-only: hold until trip end
    };
    await rec.start();
    recorder.current = rec;
    setRecording(true);
    ticker.current = setInterval(() => setSamples(rec.sampleCount), 1000);
  }

  const status = autoCapturing
    ? "● Capturing — phone mounted"
    : recording
    ? "● Recording trip"
    : detect
    ? "Watching for drives — I'll notify you"
    : "Idle";

  return (
    <View style={styles.c}>
      <Text style={styles.title}>RoadSense</Text>
      <Text style={styles.status}>{status}</Text>

      <View style={styles.row}>
        <Text style={styles.label}>Notify me to capture when driving</Text>
        <Switch value={detect} onValueChange={toggleDetect} />
      </View>
      <Text style={styles.muted}>
        When you appear to be driving, you'll get a notification. Mount your phone
        in its holder, then tap it to start mapping — it never auto-starts, so an
        unmounted phone won't record bad data. Detection itself is battery-light.
      </Text>
      {autoCapturing && (
        <TouchableOpacity style={[styles.btn, styles.stop]} onPress={stopCapture}>
          <Text style={styles.btnText}>Stop capturing</Text>
        </TouchableOpacity>
      )}

      <View style={styles.row}>
        <Text style={styles.label}>Upload on Wi-Fi only</Text>
        <Switch value={wifi} onValueChange={toggleWifi} />
      </View>
      <Text style={styles.muted}>
        Holds data during the drive and syncs once at the end, only on Wi-Fi —
        saves cellular data and battery. Otherwise uploads each batch as it fills.
      </Text>

      <TouchableOpacity style={[styles.btn, recording && styles.stop]} onPress={toggleManual}>
        <Text style={styles.btnText}>{recording ? "Stop trip" : "Start trip manually"}</Text>
      </TouchableOpacity>
      {recording && <Text style={styles.muted}>{samples} samples in current batch</Text>}

      <Text style={styles.muted}>Logs IMU @50 Hz + GPS @1 Hz. Mount the phone for valid road data.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  title: { fontSize: 28, fontWeight: "700" },
  status: { fontSize: 16, marginBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  label: { fontSize: 15, flexShrink: 1 },
  muted: { color: "#666", fontSize: 12, textAlign: "center", maxWidth: 320 },
  btn: { backgroundColor: "#2ecc71", paddingVertical: 14, paddingHorizontal: 40, borderRadius: 12, marginVertical: 12 },
  stop: { backgroundColor: "#e74c3c" },
  btnText: { color: "#fff", fontSize: 18, fontWeight: "600" },
});
