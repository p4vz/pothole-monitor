// RoadSense web collector.
// Logs accelerometer (incl. gravity) + gyroscope via DeviceMotion and GPS via
// Geolocation into per-minute batches, buffers them in IndexedDB (offline-safe),
// and uploads gzipped to the backend /v1/batches. The backend stores the raw
// data and runs the analysis — this page never needs a GitHub token.
(function () {
  "use strict";

  var CFG = window.CONFIG || {};
  var API = (new URLSearchParams(location.search).get("api") || CFG.API_BASE || location.origin).replace(/\/$/, "");

  // ---- tiny DOM helpers ----
  var $ = function (id) { return document.getElementById(id); };
  function set(id, txt) { var el = $(id); if (el) el.textContent = txt; }
  function log(msg) {
    var el = $("log");
    if (el) el.textContent = (new Date().toLocaleTimeString() + "  " + msg + "\n" + el.textContent).slice(0, 2000);
  }

  // ---- IndexedDB batch queue (survives reload / offline) ----
  function db() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open("roadsense", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("batches", { keyPath: "batch_id" }); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  async function dbPut(b) { var d = await db(); return new Promise(function (res, rej) { var tx = d.transaction("batches", "readwrite"); tx.objectStore("batches").put(b); tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; }); }
  async function dbAll() { var d = await db(); return new Promise(function (res, rej) { var tx = d.transaction("batches", "readonly"); var rq = tx.objectStore("batches").getAll(); rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { rej(rq.error); }; }); }
  async function dbDel(id) { var d = await db(); return new Promise(function (res, rej) { var tx = d.transaction("batches", "readwrite"); tx.objectStore("batches").delete(id); tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; }); }

  // ---- device token (anonymous registration) ----
  async function getToken() {
    var tok = localStorage.getItem("rs_token");
    if (tok) return tok;
    var res = await fetch(API + "/v1/devices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_version: "web-1.0" }),
    });
    if (!res.ok) throw new Error("device registration failed (" + res.status + ")");
    var tokenOut = (await res.json()).token;
    localStorage.setItem("rs_token", tokenOut);
    return tokenOut;
  }

  // ---- gzip (graceful fallback if CompressionStream is unavailable) ----
  async function gzipJson(obj) {
    var json = JSON.stringify(obj);
    if (!("CompressionStream" in window)) return { body: json, enc: null };
    var stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    return { body: await new Response(stream).arrayBuffer(), enc: "gzip" };
  }

  // ---- recording state ----
  var recording = false;
  var sessionId = null;
  var imu, gps, lastFix;
  var motionHandler = null, geoWatch = null, batchTimer = null, uiTimer = null, wakeLock = null;
  var pending = 0, lastUpload = "never";

  function freshBatch() {
    imu = { t: [], ax: [], ay: [], az: [], gx: [], gy: [], gz: [] };
    gps = [];
  }

  function onMotion(e) {
    var a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    var t = Date.now() / 1000;
    imu.t.push(t);
    imu.ax.push(a.x); imu.ay.push(a.y); imu.az.push(a.z);
    var r = e.rotationRate || {};
    var d2r = Math.PI / 180;
    // rotationRate: beta=around x, gamma=around y, alpha=around z (deg/s).
    imu.gx.push((r.beta || 0) * d2r);
    imu.gy.push((r.gamma || 0) * d2r);
    imu.gz.push((r.alpha || 0) * d2r);
  }

  function onPosition(p) {
    var c = p.coords;
    lastFix = c;
    gps.push({
      t: p.timestamp / 1000,
      lat: c.latitude, lng: c.longitude,
      speed: c.speed == null ? 0 : c.speed,
      heading: c.heading == null ? 0 : c.heading,
      acc: c.accuracy == null ? 0 : c.accuracy,
    });
  }

  async function closeBatch() {
    if (imu.t.length < 10) return; // not enough to be useful
    var token = localStorage.getItem("rs_token") || "anon";
    var batch = {
      batch_id: token.slice(0, 8) + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      meta: { session_id: sessionId, sample_rate: Math.round(imu.t.length / CFG.BATCH_SECONDS) },
      imu: imu, gps: gps,
    };
    freshBatch();
    await dbPut(batch);
    log("batch closed (" + batch.imu.t.length + " samples) -> queued");
    flush();
  }

  // ---- upload all queued batches; offline-safe (failures stay queued) ----
  var flushing = false;
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      var token = await getToken();
      var batches = await dbAll();
      for (var i = 0; i < batches.length; i++) {
        var b = batches[i];
        var delay = CFG.UPLOAD_RETRY_BASE_MS, ok = false;
        for (var attempt = 0; attempt <= CFG.UPLOAD_MAX_RETRIES; attempt++) {
          try {
            var g = await gzipJson(b);
            var headers = { "Content-Type": "application/json", "X-Device-Token": token };
            if (g.enc) headers["Content-Encoding"] = g.enc;
            var res = await fetch(API + "/v1/batches", { method: "POST", headers: headers, body: g.body });
            if (res.ok) { ok = true; break; }
          } catch (err) { /* offline / network — back off */ }
          await new Promise(function (r) { setTimeout(r, delay); });
          delay *= 2;
        }
        if (ok) { await dbDel(b.batch_id); lastUpload = new Date().toLocaleTimeString(); log("uploaded " + b.batch_id); }
        else { log("upload deferred (will retry): " + b.batch_id); break; }
      }
    } catch (err) {
      log("flush error: " + err.message);
    } finally {
      flushing = false;
      pending = (await dbAll()).length;
    }
  }

  async function refreshUI() {
    set("samples", recording ? String(imu.t.length) : "0");
    pending = (await dbAll()).length;
    set("pending", String(pending));
    set("lastUpload", lastUpload);
    if (lastFix) set("gps", lastFix.latitude.toFixed(5) + ", " + lastFix.longitude.toFixed(5) + "  ±" + Math.round(lastFix.accuracy) + "m" + (lastFix.speed ? "  " + (lastFix.speed * 3.6).toFixed(0) + " km/h" : ""));
  }

  async function requestMotionPermission() {
    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
      var state = await DeviceMotionEvent.requestPermission();
      if (state !== "granted") throw new Error("motion permission denied");
    }
  }

  async function start() {
    try {
      set("status", "starting…");
      await getToken();
      await requestMotionPermission();
      freshBatch();
      lastFix = null;
      sessionId = "web-" + Date.now();

      motionHandler = onMotion;
      window.addEventListener("devicemotion", motionHandler);
      geoWatch = navigator.geolocation.watchPosition(onPosition, function (e) { log("gps error: " + e.message); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });

      batchTimer = setInterval(closeBatch, CFG.BATCH_SECONDS * 1000);
      uiTimer = setInterval(refreshUI, 1000);
      try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* optional */ }

      recording = true;
      $("toggle").textContent = "Stop trip";
      $("toggle").classList.add("stop");
      set("status", "● Recording — drive normally");
      log("trip started");
      flush(); // send anything left from a previous trip
    } catch (err) {
      set("status", "could not start: " + err.message);
      log("start failed: " + err.message);
    }
  }

  async function stop() {
    recording = false;
    if (motionHandler) window.removeEventListener("devicemotion", motionHandler);
    if (geoWatch != null) navigator.geolocation.clearWatch(geoWatch);
    clearInterval(batchTimer); clearInterval(uiTimer);
    if (wakeLock) { try { await wakeLock.release(); } catch (e) {} wakeLock = null; }
    await closeBatch();
    await flush();
    $("toggle").textContent = "Start trip";
    $("toggle").classList.remove("stop");
    set("status", "Idle");
    set("samples", "0");
    log("trip stopped");
  }

  // ---- wiring ----
  window.addEventListener("online", flush);
  document.addEventListener("DOMContentLoaded", function () {
    set("api", API);
    $("toggle").addEventListener("click", function () { recording ? stop() : start(); });
    refreshUI();
    flush(); // resume any pending uploads from a previous session
    // Surface backend reachability early.
    fetch(API + "/healthz").then(function (r) { return r.json(); })
      .then(function (j) { set("status", "Idle — backend ok (h3 res " + j.h3_resolution + ")"); })
      .catch(function () { set("status", "Idle — ⚠ backend unreachable at " + API); });
  });
})();
