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

  // ---- live readout + on-device pothole ping ----
  var LIVE_SECONDS = 10;                       // rolling window shown on the plots
  var POTHOLE_THRESH = CFG.POTHOLE_THRESH || 2.5;  // m/s^2 vertical jolt (matches server)
  var live = [];        // recent samples {t, ax..gz} for plotting
  var pings = [];       // recent detections {t, mag}
  var gEma = null;      // EMA gravity estimate, for orientation-free vertical accel
  var potCount = 0;     // detections this trip
  var soundEnabled = false;  // audible ding is opt-in (off by default, stays silent)
  var audioCtx = null;  // created only when the user ticks the sound checkbox
  var drawReq = null;

  function freshBatch() {
    imu = { t: [], ax: [], ay: [], az: [], gx: [], gy: [], gz: [] };
    gps = [];
  }

  function onMotion(e) {
    var a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    var t = Date.now() / 1000;
    var r = e.rotationRate || {};
    var d2r = Math.PI / 180;
    // rotationRate: beta=around x, gamma=around y, alpha=around z (deg/s).
    var gx = (r.beta || 0) * d2r, gy = (r.gamma || 0) * d2r, gz = (r.alpha || 0) * d2r;

    imu.t.push(t);
    imu.ax.push(a.x); imu.ay.push(a.y); imu.az.push(a.z);
    imu.gx.push(gx); imu.gy.push(gy); imu.gz.push(gz);

    live.push({ t: t, ax: a.x, ay: a.y, az: a.z, gx: gx, gy: gy, gz: gz });

    // Orientation-free vertical jolt: EMA gravity -> linear accel projected on
    // gravity. A peak above threshold is a candidate pothole (debounced 0.6 s).
    if (!gEma) gEma = [a.x, a.y, a.z];
    var k = 0.04;
    gEma[0] += k * (a.x - gEma[0]); gEma[1] += k * (a.y - gEma[1]); gEma[2] += k * (a.z - gEma[2]);
    var gm = Math.hypot(gEma[0], gEma[1], gEma[2]) || 1;
    var vert = ((a.x - gEma[0]) * gEma[0] + (a.y - gEma[1]) * gEma[1] + (a.z - gEma[2]) * gEma[2]) / gm;
    var lastT = pings.length ? pings[pings.length - 1].t : 0;
    if (Math.abs(vert) > POTHOLE_THRESH && t - lastT > 0.6) {
      pings.push({ t: t, mag: Math.abs(vert) });
      potCount++;
      firePing(Math.abs(vert));
    }
  }

  // ---- pothole feedback: flash a badge over the plots + short beep ----
  function firePing(mag) {
    var b = $("potholeBadge");
    if (b) { b.classList.add("show"); clearTimeout(b._t); b._t = setTimeout(function () { b.classList.remove("show"); }, 1000); }
    beep();
    log("pothole detected (vert " + mag.toFixed(1) + " m/s²)");
  }
  function beep() {
    try {
      if (!soundEnabled || !audioCtx) return;
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = 880;
      o.connect(g); g.connect(audioCtx.destination);
      var t = audioCtx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.start(t); o.stop(t + 0.2);
    } catch (e) { /* audio optional */ }
  }

  // ---- live plots: ax/ay/az and gx/gy/gz vs time, autoscaled, with ping marks ----
  var AXIS_COLORS = ["#e74c3c", "#2ecc71", "#2a7de1"];
  function sizeCanvas(c) {
    var dpr = window.devicePixelRatio || 1;
    var w = c.clientWidth || 430;
    var want = Math.round(w * dpr), wantH = Math.round((c.clientHeight || 110) * dpr);
    if (c.width !== want || c.height !== wantH) { c.width = want; c.height = wantH; }
    return dpr;
  }
  function drawSeries(canvas, keys, now, floorSpan) {
    if (!canvas) return;
    var ctx = canvas.getContext("2d"), dpr = sizeCanvas(canvas);
    var W = canvas.width, H = canvas.height, mid = H / 2, t0 = now - LIVE_SECONDS, t1 = now;
    ctx.clearRect(0, 0, W, H);
    var maxv = 0, i, k;
    for (i = 0; i < live.length; i++) {
      if (live[i].t < t0) continue;
      for (k = 0; k < keys.length; k++) { var av = Math.abs(live[i][keys[k]]); if (av > maxv) maxv = av; }
    }
    var span = Math.max(maxv * 1.1, floorSpan);
    function X(t) { return ((t - t0) / (t1 - t0)) * W; }
    function Y(v) { return mid - (v / span) * (mid - 6 * dpr); }
    ctx.strokeStyle = "#23303d"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
    for (var pi = 0; pi < pings.length; pi++) {
      if (pings[pi].t < t0) continue;
      var px = X(pings[pi].t);
      ctx.strokeStyle = "rgba(231,76,60,.55)"; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke(); ctx.setLineDash([]);
    }
    for (k = 0; k < keys.length; k++) {
      ctx.strokeStyle = AXIS_COLORS[k]; ctx.lineWidth = 1.4 * dpr; ctx.beginPath();
      var started = false;
      for (i = 0; i < live.length; i++) {
        var s = live[i]; if (s.t < t0) continue;
        var x = X(s.t), y = Y(s[keys[k]]);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.fillStyle = "#7a8694"; ctx.font = (10 * dpr) + "px system-ui"; ctx.textAlign = "right";
    ctx.fillText("±" + span.toFixed(1), W - 4 * dpr, 12 * dpr);
  }
  function drawLive() {
    if (!recording) return;
    var now = Date.now() / 1000, t0 = now - LIVE_SECONDS - 0.5;
    while (live.length && live[0].t < t0) live.shift();
    while (pings.length && pings[0].t < t0) pings.shift();
    drawSeries($("plotAccel"), ["ax", "ay", "az"], now, 4);
    drawSeries($("plotGyro"), ["gx", "gy", "gz"], now, 1);
    set("potCount", potCount ? potCount + (potCount === 1 ? " pothole" : " potholes") : "");
    drawReq = requestAnimationFrame(drawLive);
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
      live = []; pings = []; gEma = null; potCount = 0;

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
      drawReq = requestAnimationFrame(drawLive);
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
    if (drawReq) cancelAnimationFrame(drawReq); drawReq = null;
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
    // Audible ding is opt-in. Ticking the box is the user gesture that lets the
    // browser create/resume audio (it may prompt); unticking goes silent again.
    var st = $("soundToggle");
    if (st) st.addEventListener("change", function () {
      soundEnabled = st.checked;
      if (soundEnabled) {
        try {
          audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
          if (audioCtx.resume) audioCtx.resume();
          beep(); // tiny confirmation tone
        } catch (e) { log("sound unavailable: " + e.message); soundEnabled = st.checked = false; }
      }
    });
    refreshUI();
    flush(); // resume any pending uploads from a previous session
    // Surface backend reachability early.
    fetch(API + "/healthz").then(function (r) { return r.json(); })
      .then(function (j) { set("status", "Idle — backend ok (h3 res " + j.h3_resolution + ")"); })
      .catch(function () { set("status", "Idle — ⚠ backend unreachable at " + API); });
  });
})();
