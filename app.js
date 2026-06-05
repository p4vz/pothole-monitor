/* Pavement Holes — pothole reporter.
 * Captures GPS + accelerometer, derives severity from the jolt, shows reports on
 * a Google Map, and persists them to a JSON file in this repo via the GitHub
 * Contents API. Viewing needs nothing; reporting needs sensor permissions and a
 * GitHub token kept only in localStorage. */
(function () {
  "use strict";
  var CONFIG = window.CONFIG;

  // ---- constants ----
  var SEV_COLOR = { small: "#f6c343", medium: "#f08c00", large: "#e03131" };
  var SEV_SCALE = { small: 6, medium: 8, large: 11 };
  var TOKEN_KEY = "ph_gh_token";

  // ---- state ----
  var map = null, infoWindow = null, userMarker = null;
  var reports = [];                 // all records
  var markers = new Map();          // id -> google.maps.Marker
  var activeFilters = new Set(["small", "medium", "large"]);

  var lastFix = null;               // {lat,lng,accuracy,speed}
  var watchId = null;

  var motionAttached = false;
  var gravity = { x: 0, y: 0, z: 0 };
  var baselineInit = false;
  var currentJolt = 0, peakWindow = 0;
  var lastReadoutPaint = 0, lastDetectMsg = "–";

  var driving = false, lastDetectionTs = 0, autoCount = 0;
  var buffer = [], flushTimer = null, wakeLock = null;
  var perms = { motion: "unknown", geo: "unknown", wake: "unknown" };

  // =====================================================================
  // Google Maps bootstrap
  // =====================================================================
  function loadGoogleMaps() {
    var s = document.createElement("script");
    s.src = "https://maps.googleapis.com/maps/api/js?key=" +
      encodeURIComponent(CONFIG.MAPS_API_KEY) + "&callback=initMap&v=quarterly";
    s.async = true; s.defer = true;
    s.onerror = function () { toast("Failed to load Google Maps"); loadReports(); };
    document.head.appendChild(s);
  }
  window.gm_authFailure = function () {
    toast("Google Maps auth failed — check the API key / referrer restriction");
  };

  function initMap() {
    map = new google.maps.Map(document.getElementById("map"), {
      center: { lat: 51.5074, lng: -0.1278 }, zoom: 13,
      mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
    });
    infoWindow = new google.maps.InfoWindow();
    loadReports();
    quietLocate();
  }
  window.initMap = initMap;

  // =====================================================================
  // Data load + render (the viewer)
  // =====================================================================
  function loadReports() {
    var url = "https://raw.githubusercontent.com/" + CONFIG.REPO_OWNER + "/" +
      CONFIG.REPO_NAME + "/" + CONFIG.TARGET_BRANCH + "/" + CONFIG.DATA_PATH +
      "?t=" + Date.now();
    fetch(url, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; })
      .then(function (data) {
        reports = Array.isArray(data) ? data : [];
        renderAll();
      });
  }

  function renderAll() {
    markers.forEach(function (m) { m.setMap(null); });
    markers.clear();
    if (map && window.google) reports.forEach(addMarker);
    applyFilter();
    renderList();
  }

  function addMarker(r) {
    if (!map || !window.google) return;
    var sev = r.severity || "small";
    var m = new google.maps.Marker({
      position: { lat: r.lat, lng: r.lng }, map: map,
      title: sev + " pothole",
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: SEV_SCALE[sev] || 7,
        fillColor: SEV_COLOR[sev] || "#868e96",
        fillOpacity: 0.85, strokeColor: "#fff", strokeWeight: 1.5,
      },
    });
    m.addListener("click", function () { openInfo(r, m); });
    markers.set(r.id, m);
  }

  function openInfo(r, m) {
    if (!infoWindow) return;
    var when = new Date(r.timestamp).toLocaleString();
    var accel = r.peakAccel != null ? r.peakAccel.toFixed(1) + " m/s²" : "—";
    var spd = r.speed != null ? Math.round(r.speed * 3.6) + " km/h" : "—";
    infoWindow.setContent(
      '<div style="font:13px system-ui;min-width:170px">' +
      '<b style="text-transform:capitalize">' + esc(r.severity) + "</b> pothole<br>" +
      esc(when) + "<br>jolt: " + accel + "<br>speed: " + spd +
      "<br>source: " + esc(r.source || "?") + "</div>");
    infoWindow.open(map, m);
  }

  function applyFilter() {
    reports.forEach(function (r) {
      var m = markers.get(r.id);
      if (m) m.setMap(activeFilters.has(r.severity) ? map : null);
    });
  }

  function renderList() {
    var ul = document.getElementById("list");
    ul.innerHTML = "";
    var visible = reports.filter(function (r) { return activeFilters.has(r.severity); })
      .sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
    document.getElementById("count").textContent =
      visible.length + " report" + (visible.length !== 1 ? "s" : "");
    visible.forEach(function (r) {
      var li = document.createElement("li");
      var dist = lastFix ? " • " + fmtDist(haversine(lastFix.lat, lastFix.lng, r.lat, r.lng)) : "";
      li.innerHTML = '<span class="dot ' + esc(r.severity) + '"></span>' +
        '<span class="meta"><b style="text-transform:capitalize">' + esc(r.severity) +
        "</b> • " + esc(new Date(r.timestamp).toLocaleString()) + dist + "</span>";
      li.addEventListener("click", function () {
        var m = markers.get(r.id);
        if (m) {
          map.panTo(m.getPosition());
          map.setZoom(Math.max(map.getZoom() || 16, 16));
          openInfo(r, m);
        }
      });
      ul.appendChild(li);
    });
  }

  // Add a freshly-created record to the local view immediately.
  function addLocal(rec) {
    reports.push(rec);
    addMarker(rec);
    applyFilter();
    renderList();
  }

  // =====================================================================
  // Geolocation
  // =====================================================================
  function updateFix(pos) {
    var c = pos.coords;
    lastFix = {
      lat: c.latitude, lng: c.longitude, accuracy: c.accuracy,
      speed: (c.speed != null && !isNaN(c.speed)) ? c.speed : null,
    };
  }

  function setUserMarker() {
    if (!map || !window.google || !lastFix) return;
    var pos = { lat: lastFix.lat, lng: lastFix.lng };
    if (!userMarker) {
      userMarker = new google.maps.Marker({
        position: pos, map: map, title: "You", zIndex: 9999,
        icon: {
          path: google.maps.SymbolPath.CIRCLE, scale: 7,
          fillColor: "#1c7ed6", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2.5,
        },
      });
    } else {
      userMarker.setPosition(pos);
    }
  }

  function quietLocate() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function (pos) {
      updateFix(pos); setUserMarker();
      if (map) map.panTo({ lat: lastFix.lat, lng: lastFix.lng });
      renderList();
    }, function () {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  }

  function locateMe() {
    if (!navigator.geolocation) { toast("Geolocation unavailable"); return; }
    navigator.geolocation.getCurrentPosition(function (pos) {
      updateFix(pos); setUserMarker();
      if (map) { map.panTo({ lat: lastFix.lat, lng: lastFix.lng }); map.setZoom(16); }
      renderList();
    }, function (err) { toast("Location error: " + err.message); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
  }

  function requestGeo() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) { setPerm("geo", "unavailable"); return resolve(); }
      navigator.geolocation.getCurrentPosition(function (pos) {
        updateFix(pos); setUserMarker();
        if (map) map.panTo({ lat: lastFix.lat, lng: lastFix.lng });
        setPerm("geo", "granted"); resolve();
      }, function (err) {
        setPerm("geo", err.code === 1 ? "denied" : "error"); resolve();
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    });
  }

  function startWatch() {
    if (!navigator.geolocation || watchId != null) return;
    watchId = navigator.geolocation.watchPosition(function (pos) {
      updateFix(pos); setUserMarker(); paintReadout(true);
    }, function (err) { setReadout("gps error: " + err.message); },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
  }
  function stopWatch() {
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }

  // =====================================================================
  // Accelerometer / motion
  // =====================================================================
  function attachMotion() {
    if (motionAttached) return true;
    if (typeof DeviceMotionEvent === "undefined") return false;
    window.addEventListener("devicemotion", onMotion);
    motionAttached = true;
    return true;
  }

  function onMotion(e) {
    var a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    // Seed the gravity estimate from the first reading so the low-pass doesn't
    // ramp up from zero — that warm-up transient would otherwise fire a spurious
    // detection (and, via the cooldown, mask a real jolt) right after enabling.
    if (!baselineInit) {
      gravity.x = a.x; gravity.y = a.y; gravity.z = a.z;
      baselineInit = true;
      return;
    }
    // Low-pass to track gravity; the residual is the jolt (linear acceleration).
    var alpha = 0.8;
    gravity.x = alpha * gravity.x + (1 - alpha) * a.x;
    gravity.y = alpha * gravity.y + (1 - alpha) * a.y;
    gravity.z = alpha * gravity.z + (1 - alpha) * a.z;
    var dx = a.x - gravity.x, dy = a.y - gravity.y, dz = a.z - gravity.z;
    currentJolt = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (currentJolt > peakWindow) peakWindow = currentJolt;
    if (driving) maybeDetect();
    // Once the jolt subsides, clear the running peak so the next event is rated
    // on its own — a bump suppressed by the cooldown must not inflate the
    // severity of the following report.
    if (currentJolt < CONFIG.JOLT_THRESHOLD) peakWindow = 0;
    paintReadout(false);
  }

  function severityFromAccel(a) {
    if (a == null) return null;
    var c = CONFIG.SEVERITY_CUTOFFS;
    if (a >= c.large) return "large";
    if (a >= c.medium) return "medium";
    return "small";
  }

  // =====================================================================
  // Driving auto-detection
  // =====================================================================
  function maybeDetect() {
    var now = Date.now();
    if (currentJolt < CONFIG.JOLT_THRESHOLD) return;
    if (now - lastDetectionTs < CONFIG.DETECTION_COOLDOWN_MS) return;
    if (!lastFix) return;
    var speed = lastFix.speed;
    if (speed != null && speed < CONFIG.MIN_SPEED_MPS) return; // stationary gate
    lastDetectionTs = now;
    var peak = peakWindow; peakWindow = 0;
    var rec = makeRecord(peak, severityFromAccel(peak), "auto", speed);
    addLocal(rec);
    buffer.push(rec);
    autoCount++;
    lastDetectMsg = rec.severity + " (" + peak.toFixed(1) + ")";
    flashDetection(rec.severity);
    toast("🕳️ Pothole auto-logged — " + rec.severity + " (" + peak.toFixed(1) + " m/s²)");
    paintReadout(true);
    if (buffer.length >= CONFIG.BATCH_FLUSH_COUNT) flushBuffer();
  }

  function makeRecord(peakAccel, severity, source, speed) {
    return {
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      lat: round(lastFix.lat, 6), lng: round(lastFix.lng, 6),
      accuracy: lastFix.accuracy != null ? round(lastFix.accuracy, 1) : null,
      severity: severity || "small",
      peakAccel: peakAccel != null ? round(peakAccel, 2) : null,
      speed: speed != null ? round(speed, 2) : null,
      source: source,
      timestamp: new Date().toISOString(),
    };
  }

  function toggleDriving() {
    driving = !driving;
    var btn = document.getElementById("drivingBtn");
    if (driving) {
      autoCount = 0;
      if (!motionAttached) requestMotion();
      startWatch();
      acquireWake();
      btn.classList.add("on");
      btn.textContent = "🚗 Reporting mode: ON";
      scheduleFlush();
      toast("Reporting mode on — watching for jolts, auto-logging potholes");
    } else {
      stopWatch();
      releaseWake();
      btn.classList.remove("on");
      btn.textContent = "🚗 Reporting mode: off";
      clearTimeout(flushTimer);
      flushBuffer();
      toast("Reporting mode off" + (autoCount ? " — logged " + autoCount + " this trip" : ""));
    }
    paintReadout(true);
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(function () {
      flushBuffer().then(function () { if (driving) scheduleFlush(); });
    }, CONFIG.BATCH_FLUSH_MS);
  }

  // =====================================================================
  // Permissions priming
  // =====================================================================
  function enableSensors() {
    requestMotion()
      .then(requestGeo)
      .then(function () { return acquireWake().then(releaseWake); })
      .then(function () { toast("Sensor setup complete"); });
  }

  function requestMotion() {
    return new Promise(function (resolve) {
      if (typeof DeviceMotionEvent === "undefined") { setPerm("motion", "unavailable"); return resolve(); }
      if (typeof DeviceMotionEvent.requestPermission === "function") {
        DeviceMotionEvent.requestPermission().then(function (res) {
          if (res === "granted") { attachMotion(); setPerm("motion", "granted"); }
          else setPerm("motion", "denied");
          resolve();
        }).catch(function () { setPerm("motion", "denied"); resolve(); });
      } else {
        attachMotion();
        setPerm("motion", motionAttached ? "granted" : "unavailable");
        resolve();
      }
    });
  }

  function acquireWake() {
    if (!("wakeLock" in navigator)) { setPerm("wake", "unavailable"); return Promise.resolve(); }
    return navigator.wakeLock.request("screen").then(function (wl) {
      wakeLock = wl; setPerm("wake", "granted");
      wl.addEventListener("release", function () { /* may auto-release on hide */ });
    }).catch(function () { setPerm("wake", "denied"); });
  }
  function releaseWake() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }
  document.addEventListener("visibilitychange", function () {
    if (driving && document.visibilityState === "visible" && !wakeLock) acquireWake();
  });

  // =====================================================================
  // Manual report
  // =====================================================================
  function reportHere() {
    var go = lastFix ? Promise.resolve() : requestGeo();
    go.then(function () {
      if (!lastFix) { toast("No location yet — allow location access"); return; }
      var sel = document.getElementById("severitySel").value;
      var peak = motionAttached ? peakWindow : null;
      peakWindow = 0;
      var severity = sel === "auto" ? (severityFromAccel(peak) || "small") : sel;
      var rec = makeRecord(peak, severity, "manual", lastFix.speed);
      addLocal(rec);
      setStatus("Saving…");
      saveReports([rec]).then(function () {
        setStatus("Saved " + severity + " pothole.");
        toast("Report saved");
      }).catch(function (err) { setStatus("Save failed: " + err.message); });
    });
  }

  // =====================================================================
  // Persistence — GitHub Contents API
  // =====================================================================
  function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }

  function ghHeaders(token) {
    return {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  function flushBuffer() {
    if (buffer.length === 0) return Promise.resolve();
    var pending = buffer.splice(0, buffer.length);
    return saveReports(pending).then(function () {
      setStatus("Saved " + pending.length + " report(s) to GitHub.");
    }).catch(function (err) {
      buffer = pending.concat(buffer); // requeue for next flush
      setStatus("Save failed: " + err.message + " — will retry.");
    });
  }

  function saveReports(records) {
    var token = getToken();
    if (!token) return Promise.reject(new Error("No GitHub token set"));
    var attempt = function () {
      return getRemote(token).then(function (remote) {
        var merged = remote.array.concat(records);
        return putRemote(token, merged, remote.sha, records.length);
      });
    };
    // Retry once on a sha conflict (concurrent write).
    return attempt().catch(function (e) {
      if (e && e.conflict) return attempt();
      throw e;
    });
  }

  function getRemote(token) {
    var url = "https://api.github.com/repos/" + CONFIG.REPO_OWNER + "/" +
      CONFIG.REPO_NAME + "/contents/" + CONFIG.DATA_PATH +
      "?ref=" + encodeURIComponent(CONFIG.TARGET_BRANCH);
    return fetch(url, { headers: ghHeaders(token), cache: "no-store" }).then(function (res) {
      if (res.status === 404) return { array: [], sha: undefined };
      if (!res.ok) throw new Error("read " + res.status);
      return res.json().then(function (data) {
        var text = decodeB64(data.content || "");
        var array = [];
        try { array = JSON.parse(text) || []; } catch (e) { array = []; }
        return { array: Array.isArray(array) ? array : [], sha: data.sha };
      });
    });
  }

  function putRemote(token, array, sha, n) {
    var url = "https://api.github.com/repos/" + CONFIG.REPO_OWNER + "/" +
      CONFIG.REPO_NAME + "/contents/" + CONFIG.DATA_PATH;
    var body = {
      message: "Add " + n + " pothole report" + (n !== 1 ? "s" : ""),
      content: encodeB64(JSON.stringify(array, null, 2) + "\n"),
      branch: CONFIG.TARGET_BRANCH,
    };
    if (sha) body.sha = sha;
    return fetch(url, { method: "PUT", headers: ghHeaders(token), body: JSON.stringify(body) })
      .then(function (res) {
        if (res.status === 409) { var c = new Error("sha conflict"); c.conflict = true; throw c; }
        if (!res.ok) return res.text().then(function (t) {
          throw new Error("write " + res.status + ": " + t.slice(0, 120));
        });
      });
  }

  // UTF-8 safe base64
  function encodeB64(str) { return btoa(unescape(encodeURIComponent(str))); }
  function decodeB64(b64) { return decodeURIComponent(escape(atob(String(b64).replace(/\s/g, "")))); }

  // =====================================================================
  // UI helpers
  // =====================================================================
  function setPerm(name, val) {
    perms[name] = val;
    var el = document.getElementById("perm-" + name);
    if (el) el.textContent = val;
  }
  function setStatus(msg) { var el = document.getElementById("status"); if (el) el.textContent = msg; }
  function setReadout(msg) { lastDetectMsg = msg; paintReadout(true); }
  function paintReadout(force) {
    var now = Date.now();
    if (!force && now - lastReadoutPaint < 200) return;
    lastReadoutPaint = now;
    var el = document.getElementById("readout");
    if (!el) return;
    var spd = lastFix && lastFix.speed != null ? Math.round(lastFix.speed * 3.6) + " km/h" : "–";
    el.textContent = "jolt: " + currentJolt.toFixed(1) + " • speed: " + spd +
      " • " + (driving ? "🟢 watching" : "⚪ idle") +
      " • logged: " + autoCount +
      " • last: " + lastDetectMsg;
  }

  // Brief full-screen colour pulse so a caught jolt is obvious while driving.
  function flashDetection(sev) {
    var el = document.getElementById("flash");
    if (!el) return;
    el.style.background = SEV_COLOR[sev] || "#e03131";
    el.style.transition = "none";
    el.style.opacity = "0.55";
    void el.offsetWidth;            // force reflow so the fade-out animates
    el.style.transition = "opacity 0.6s ease-out";
    el.style.opacity = "0";
  }
  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg; t.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.display = "none"; }, 3200);
  }

  // ---- small math/utils ----
  function round(n, d) { var f = Math.pow(10, d); return Math.round(n * f) / f; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function fmtDist(m) { return m < 1000 ? Math.round(m) + " m" : (m / 1000).toFixed(1) + " km"; }

  // =====================================================================
  // Wire up the DOM
  // =====================================================================
  function ready() {
    // Panel collapse
    document.getElementById("panelHeader").addEventListener("click", function () {
      var p = document.getElementById("panel");
      p.classList.toggle("collapsed");
      document.getElementById("collapseIcon").textContent =
        p.classList.contains("collapsed") ? "▸" : "▾";
    });
    // Filters
    Array.prototype.forEach.call(document.querySelectorAll(".sev-filter"), function (cb) {
      cb.addEventListener("change", function () {
        if (cb.checked) activeFilters.add(cb.value); else activeFilters.delete(cb.value);
        applyFilter(); renderList();
      });
    });
    // Buttons
    document.getElementById("locateBtn").addEventListener("click", locateMe);
    document.getElementById("enableBtn").addEventListener("click", enableSensors);
    document.getElementById("drivingBtn").addEventListener("click", toggleDriving);
    document.getElementById("reportBtn").addEventListener("click", reportHere);
    // Token management
    var tokenInput = document.getElementById("tokenInput");
    if (getToken()) tokenInput.placeholder = "Token saved — enter to replace";
    document.getElementById("saveTokenBtn").addEventListener("click", function () {
      var v = tokenInput.value.trim();
      if (!v) { setStatus("Enter a token first."); return; }
      localStorage.setItem(TOKEN_KEY, v);
      tokenInput.value = ""; tokenInput.placeholder = "Token saved — enter to replace";
      setStatus("Token saved in this browser.");
    });
    document.getElementById("clearTokenBtn").addEventListener("click", function () {
      localStorage.removeItem(TOKEN_KEY);
      tokenInput.placeholder = "GitHub token (contents:write)";
      setStatus("Token cleared.");
    });

    loadGoogleMaps();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready);
  } else {
    ready();
  }
})();
