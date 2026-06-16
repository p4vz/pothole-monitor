// RoadSense collector UI. Two modes:
//  • Auto-capture — detects driving and records in the background (battery-light).
//  • Manual trip — start/stop an explicit recording.
import React, { useEffect, useRef, useState } from "react";
import { Text, TouchableOpacity, View, StyleSheet, Switch, AppState } from "react-native";
import * as Location from "expo-location";

import { initBuffer } from "./src/buffer";
import { Recorder } from "./src/sensors";
import { drain } from "./src/uploader";
import { loadSettings, wifiOnly, setWifiOnly } from "./src/settings";
import {
  enableAutoCapture,
  disableAutoCapture,
  isAutoCaptureEnabled,
  onDriveStateChange,
} from "./src/driveDetect";

export default function App() {
  const [auto, setAuto] = useState(false);
  const [wifi, setWifi] = useState(false);
  const [driving, setDriving] = useState(false);
  const [recording, setRecording] = useState(false);
  const [samples, setSamples] = useState(0);
  const recorder = useRef<Recorder | null>(null);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    initBuffer().then(drain); // flush anything left from a previous trip
    loadSettings().then((s) => setWifi(s.wifiOnly));
    isAutoCaptureEnabled().then(setAuto);
    const offDrive = onDriveStateChange(setDriving);
    // Returning to the app is a good moment to flush queued (Wi-Fi-deferred) batches.
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") drain();
    });
    return () => {
      offDrive();
      sub.remove();
    };
  }, []);

  async function toggleAuto(on: boolean) {
    if (on) {
      setAuto(await enableAutoCapture());
    } else {
      await disableAutoCapture();
      setAuto(false);
      setDriving(false);
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

  const status = driving
    ? "● Driving — capturing"
    : auto
    ? "Auto-capture on — watching for drives"
    : recording
    ? "● Recording trip"
    : "Idle";

  return (
    <View style={styles.c}>
      <Text style={styles.title}>RoadSense</Text>
      <Text style={styles.status}>{status}</Text>

      <View style={styles.row}>
        <Text style={styles.label}>Auto-capture while driving</Text>
        <Switch value={auto} onValueChange={toggleAuto} />
      </View>
      <Text style={styles.muted}>
        Detects driving and records in the background — minimal battery. High-rate
        sensors run only while you're actually moving.
      </Text>

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

      <Text style={styles.muted}>Logs IMU @50 Hz + GPS @1 Hz.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  title: { fontSize: 28, fontWeight: "700" },
  status: { fontSize: 16, marginBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  label: { fontSize: 15 },
  muted: { color: "#666", fontSize: 12, textAlign: "center", maxWidth: 320 },
  btn: { backgroundColor: "#2ecc71", paddingVertical: 14, paddingHorizontal: 40, borderRadius: 12, marginVertical: 12 },
  stop: { backgroundColor: "#e74c3c" },
  btnText: { color: "#fff", fontSize: 18, fontWeight: "600" },
});
