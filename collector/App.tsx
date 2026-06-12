// Minimal trip UI: start/stop a logging session and show live status. Wires the
// Recorder's batch-close hook to the uploader so batches drain as they close.
import React, { useEffect, useRef, useState } from "react";
import { Text, TouchableOpacity, View, StyleSheet } from "react-native";
import * as Location from "expo-location";

import { initBuffer } from "./src/buffer";
import { Recorder } from "./src/sensors";
import { drain } from "./src/uploader";

export default function App() {
  const [recording, setRecording] = useState(false);
  const [samples, setSamples] = useState(0);
  const recorder = useRef<Recorder | null>(null);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    initBuffer().then(drain); // flush anything left from a previous trip
  }, []);

  async function toggle() {
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
    rec.onFlush = () => drain(); // upload each closed batch as it fills
    await rec.start();
    recorder.current = rec;
    setRecording(true);
    ticker.current = setInterval(() => setSamples(rec.sampleCount), 1000);
  }

  return (
    <View style={styles.c}>
      <Text style={styles.title}>RoadSense</Text>
      <Text style={styles.status}>{recording ? "● Recording trip" : "Idle"}</Text>
      {recording && <Text style={styles.muted}>{samples} samples in current batch</Text>}
      <TouchableOpacity style={[styles.btn, recording && styles.stop]} onPress={toggle}>
        <Text style={styles.btnText}>{recording ? "Stop trip" : "Start trip"}</Text>
      </TouchableOpacity>
      <Text style={styles.muted}>Logs IMU @50 Hz + GPS @1 Hz, uploads every batch.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  title: { fontSize: 28, fontWeight: "700" },
  status: { fontSize: 16 },
  muted: { color: "#666", fontSize: 12, textAlign: "center" },
  btn: { backgroundColor: "#2ecc71", paddingVertical: 14, paddingHorizontal: 40, borderRadius: 12, marginVertical: 16 },
  stop: { backgroundColor: "#e74c3c" },
  btnText: { color: "#fff", fontSize: 18, fontWeight: "600" },
});
