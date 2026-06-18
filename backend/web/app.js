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
  function setHTML(id, html) { var el = $(id); if (el) el.innerHTML = html; }
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
  // Pothole jolt scales with speed, so a fixed accel threshold over-fires at
  // speed and misses potholes when slow. Detect on a SPEED-NORMALIZED index
  // (|vert| / speed) instead, which is roughly speed-invariant.
  var V_FLOOR = CFG.POTHOLE_V_FLOOR || 2.0;    // m/s; treat slower than this as this
  var IDX_THRESH = CFG.POTHOLE_INDEX || 0.30;  // |vert|/speed threshold (s)
  var MIN_ABS = CFG.POTHOLE_MIN_ABS || 0.4;    // absolute vert floor, rejects noise
  var ABS_FALLBACK = CFG.POTHOLE_THRESH || 3.0;  // used only when GPS speed is unknown
  var live = [];        // recent samples {t, ax..mz} for plotting
  var pings = [];       // recent detections {t, mag}
  var gEma = null;      // EMA gravity estimate, for orientation-free vertical accel
  var potCount = 0;     // detections this trip
  var soundEnabled = false;  // audible ding is opt-in (off by default, stays silent)
  var audioCtx = null;  // created only when the user ticks the sound checkbox
  var drawReq = null;
  var magSensor = null; // Generic Sensor Magnetometer (compass), Chromium-only
  var lastMag = null;   // latest {x,y,z} microtesla reading, held between samples
  var oriAbsHandler = null, oriRelHandler = null, compassDiag = null;
  var lastOri = null;   // latest device orientation {a,b,g,abs} degrees (fallback)
  var orientGranted = true;  // iOS DeviceOrientation permission
  var sawMag = false, sawOri = false;  // which compass source actually produced data
  var compassLabeled = false;

  function freshBatch() {
    imu = { t: [], ax: [], ay: [], az: [], gx: [], gy: [], gz: [],
            mx: [], my: [], mz: [], oa: [], ob: [], og: [] };
    gps = [];
  }

  // ---- compass in 3D ----
  // Primary: raw 3-axis Magnetometer (microtesla) via Generic Sensor API. NOTE:
  // `Magnetometer` is gated behind chrome://flags/#enable-generic-sensor-extra-
  // classes, so on many phones the class is simply undefined even though the
  // hardware exists. Fallback: DeviceOrientation (heading/pitch/roll degrees),
  // which is fused from that same magnetometer and works without the flag and on
  // iOS. We capture whichever sources fire and plot the live one.
  async function startCompass() {
    lastMag = null; lastOri = null;
    if (typeof Magnetometer !== "undefined" && window.isSecureContext) {
      try {
        // Surface the permission state so we can tell "denied" from "no hardware".
        if (navigator.permissions && navigator.permissions.query) {
          try {
            var perm = await navigator.permissions.query({ name: "magnetometer" });
            log("compass: magnetometer permission = " + perm.state);
            if (perm.state === "denied") throw new Error("permission denied");
          } catch (qe) { /* some browsers reject this permission name — ignore */ }
        }
        magSensor = new Magnetometer({ frequency: 20 });
        magSensor.addEventListener("activate", function () { log("compass: magnetometer active"); });
        magSensor.addEventListener("reading", function () {
          lastMag = { x: magSensor.x, y: magSensor.y, z: magSensor.z };
        });
        magSensor.addEventListener("error", function (ev) {
          log("compass: magnetometer " + ((ev.error && ev.error.name) || "error") + " → orientation");
          try { magSensor.stop(); } catch (_) {} magSensor = null;
        });
        magSensor.start();
        log("compass: magnetometer.start() called");
      } catch (e) { log("compass: magnetometer unavailable (" + e.message + ")"); magSensor = null; }
    } else {
      log("compass: Magnetometer class absent — enable chrome://flags/#enable-generic-sensor-extra-classes, or using orientation");
    }
    startOrientation();
    // Heartbeat: after a moment, say plainly whether anything is arriving.
    if (compassDiag) clearTimeout(compassDiag);
    compassDiag = setTimeout(function () {
      if (sawMag) return;
      if (sawOri) log("compass: using device orientation (no raw magnetometer readings)");
      else log("compass: NO readings — sensor blocked/unsupported (magnetometer + orientation both silent)");
    }, 2500);
  }
  // Listen to BOTH absolute and relative orientation: some devices expose the
  // absolute event but never fire it, so relying on it alone shows nothing.
  function startOrientation() {
    if (typeof DeviceOrientationEvent === "undefined") { set("magNote", "— no orientation sensor"); return; }
    if (typeof DeviceOrientationEvent.requestPermission === "function" && !orientGranted) {
      set("magNote", "— compass permission denied"); return;
    }
    oriAbsHandler = function (e) {
      if (e.alpha == null && e.beta == null && e.gamma == null) return;
      lastOri = { a: e.alpha || 0, b: e.beta || 0, g: e.gamma || 0, abs: true };
    };
    oriRelHandler = function (e) {
      if (lastOri && lastOri.abs) return;  // prefer absolute when it's live
      if (e.alpha == null && e.beta == null && e.gamma == null) return;
      lastOri = { a: e.alpha || 0, b: e.beta || 0, g: e.gamma || 0, abs: false };
    };
    window.addEventListener("deviceorientationabsolute", oriAbsHandler);
    window.addEventListener("deviceorientation", oriRelHandler);
  }
  function stopCompass() {
    try { if (magSensor) magSensor.stop(); } catch (e) { /* ignore */ }
    magSensor = null; lastMag = null;
    if (oriAbsHandler) window.removeEventListener("deviceorientationabsolute", oriAbsHandler);
    if (oriRelHandler) window.removeEventListener("deviceorientation", oriRelHandler);
    oriAbsHandler = oriRelHandler = null;
    if (compassDiag) { clearTimeout(compassDiag); compassDiag = null; }
    lastOri = null;
  }

  function onMotion(e) {
    var a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    var t = Date.now() / 1000;
    var r = e.rotationRate || {};
    var d2r = Math.PI / 180;
    // rotationRate: beta=around x, gamma=around y, alpha=around z (deg/s).
    var gx = (r.beta || 0) * d2r, gy = (r.gamma || 0) * d2r, gz = (r.alpha || 0) * d2r;

    var mx = lastMag ? lastMag.x : null, my = lastMag ? lastMag.y : null, mz = lastMag ? lastMag.z : null;
    var oa = lastOri ? lastOri.a : null, ob = lastOri ? lastOri.b : null, og = lastOri ? lastOri.g : null;
    if (lastMag) sawMag = true;
    if (lastOri) sawOri = true;

    imu.t.push(t);
    imu.ax.push(a.x); imu.ay.push(a.y); imu.az.push(a.z);
    imu.gx.push(gx); imu.gy.push(gy); imu.gz.push(gz);
    imu.mx.push(mx); imu.my.push(my); imu.mz.push(mz);
    imu.oa.push(oa); imu.ob.push(ob); imu.og.push(og);

    live.push({ t: t, ax: a.x, ay: a.y, az: a.z, gx: gx, gy: gy, gz: gz,
                mx: mx, my: my, mz: mz, oa: oa, ob: ob, og: og });

    // Orientation-free vertical jolt: EMA gravity -> linear accel projected on
    // gravity. A peak above threshold is a candidate pothole (debounced 0.6 s).
    if (!gEma) gEma = [a.x, a.y, a.z];
    var k = 0.04;
    gEma[0] += k * (a.x - gEma[0]); gEma[1] += k * (a.y - gEma[1]); gEma[2] += k * (a.z - gEma[2]);
    var gm = Math.hypot(gEma[0], gEma[1], gEma[2]) || 1;
    var vert = ((a.x - gEma[0]) * gEma[0] + (a.y - gEma[1]) * gEma[1] + (a.z - gEma[2]) * gEma[2]) / gm;
    var av = Math.abs(vert);

    // Speed-normalized detection so the same pothole registers across speeds.
    var spd = (lastFix && lastFix.speed != null && lastFix.speed >= 0) ? lastFix.speed : null;
    var detected;
    if (spd != null) {
      detected = (av / Math.max(spd, V_FLOOR)) > IDX_THRESH && av > MIN_ABS;
    } else {
      detected = av > ABS_FALLBACK;  // no GPS speed: best-effort fixed threshold
    }
    var lastT = pings.length ? pings[pings.length - 1].t : 0;
    if (detected && t - lastT > 0.6) {
      pings.push({ t: t, mag: av });
      potCount++;
      firePing(av, spd);
    }
  }

  // ---- pothole feedback: flash a badge over the plots + short beep ----
  function firePing(mag, spd) {
    var b = $("potholeBadge");
    if (b) { b.classList.add("show"); clearTimeout(b._t); b._t = setTimeout(function () { b.classList.remove("show"); }, 1000); }
    beep();
    var at = spd != null ? " @ " + (spd * 3.6).toFixed(0) + " km/h" : "";
    log("pothole detected (vert " + mag.toFixed(1) + " m/s²" + at + ")");
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
  function drawSeries(canvas, keys, now, floorSpan, vector) {
    if (!canvas) return;
    var ctx = canvas.getContext("2d"), dpr = sizeCanvas(canvas);
    var W = canvas.width, H = canvas.height, mid = H / 2, t0 = now - LIVE_SECONDS, t1 = now;
    ctx.clearRect(0, 0, W, H);
    var maxv = 0, i, k;
    for (i = 0; i < live.length; i++) {
      var s0 = live[i]; if (s0.t < t0) continue;
      var sq0 = 0, ok0 = true;
      for (k = 0; k < keys.length; k++) {
        var vv = s0[keys[k]];
        if (vv == null) { ok0 = false; continue; }
        var av = Math.abs(vv); if (av > maxv) maxv = av; sq0 += vv * vv;
      }
      if (vector && ok0) { var mg0 = Math.sqrt(sq0); if (mg0 > maxv) maxv = mg0; }  // magnitude curve
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
        var v = s[keys[k]];
        if (v == null) { started = false; continue; }  // gap (e.g. no compass yet)
        var x = X(s.t), y = Y(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // 4th curve: vector magnitude sqrt(x²+y²+z²), in white. Only for true vectors
    // (accel/gyro/magnetometer) — meaningless for Euler angles, which wrap.
    if (vector) {
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.2 * dpr; ctx.beginPath();
      var startedM = false;
      for (i = 0; i < live.length; i++) {
        var s = live[i]; if (s.t < t0) continue;
        var sq = 0, ok = true;
        for (k = 0; k < keys.length; k++) { var v2 = s[keys[k]]; if (v2 == null) { ok = false; break; } sq += v2 * v2; }
        if (!ok) { startedM = false; continue; }
        var xm = X(s.t), ym = Y(Math.sqrt(sq));
        if (!startedM) { ctx.moveTo(xm, ym); startedM = true; } else ctx.lineTo(xm, ym);
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
    drawSeries($("plotAccel"), ["ax", "ay", "az"], now, 4, true);
    drawSeries($("plotGyro"), ["gx", "gy", "gz"], now, 1, true);
    // Compass: prefer raw magnetometer (µT, a vector → show magnitude); else
    // device orientation (degrees → no magnitude curve, angles aren't a vector).
    if (sawMag) drawSeries($("plotMag"), ["mx", "my", "mz"], now, 20, true);
    else drawSeries($("plotMag"), ["oa", "ob", "og"], now, 90, false);
    if (!compassLabeled && (sawMag || sawOri)) {
      compassLabeled = true;
      var W = '<b style="color:#fff;text-shadow:0 0 1px #555,0 0 2px #555">●</b>';
      if (sawMag) { set("magAxis", "mag µT"); setHTML("magLegend", '<b class="dotx">●</b> mx &nbsp; <b class="doty">●</b> my &nbsp; <b class="dotz">●</b> mz &nbsp; ' + W + ' |m|'); }
      else { set("magAxis", "orient °"); setHTML("magLegend", '<b class="dotx">●</b> α &nbsp; <b class="doty">●</b> β &nbsp; <b class="dotz">●</b> γ'); set("magNote", "— device orientation (no raw magnetometer)"); }
    }
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
    // Drop compass arrays entirely if no real readings (unsupported device),
    // rather than uploading aligned null-filled columns.
    if (!imu.mx.some(function (v) { return v != null; })) { delete imu.mx; delete imu.my; delete imu.mz; }
    if (!imu.oa.some(function (v) { return v != null; })) { delete imu.oa; delete imu.ob; delete imu.og; }
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
    // iOS also gates DeviceOrientation (our compass fallback) behind a prompt —
    // ask now, within the Start tap's user gesture.
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      try { orientGranted = (await DeviceOrientationEvent.requestPermission()) === "granted"; }
      catch (e) { orientGranted = false; }
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
      sawMag = false; sawOri = false; compassLabeled = false;

      motionHandler = onMotion;
      window.addEventListener("devicemotion", motionHandler);
      startCompass();
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
    stopCompass();
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
