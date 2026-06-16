// RoadSense viewer — reads segment-state GeoJSON and colours H3 hexes by
// condition (colour = severity, opacity = confidence). Keyless OSM tiles.
//
// The viewer is served by the backend, so the API is the same origin by
// default. Override with ?api=http://127.0.0.1:8000 for local development.
const API =
  new URLSearchParams(location.search).get("api") || location.origin;

const SEVERITY_COLOR = {
  smooth: "#2ecc71",
  minor: "#f1c40f",
  rough: "#e67e22",
  severe: "#e74c3c",
};

const map = L.map("map").setView([52.37, 4.9], 14); // Amsterdam default
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap contributors",
}).addTo(map);

let layer = null;
let minConfidence = 0;

function styleFor(props) {
  return {
    color: "#333",
    weight: 0.5,
    fillColor: SEVERITY_COLOR[props.severity_class] || "#999",
    // Confidence drives opacity, floored so low-confidence hexes stay visible.
    fillOpacity: 0.2 + 0.6 * Math.min(1, props.confidence),
  };
}

// Tiny dependency-free SVG sparkline of roughness over recent passes.
function sparkline(values, w = 220, h = 40) {
  if (!values.length) return "";
  const max = Math.max(...values, 0.1);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(" ");
  return `<svg width="${w}" height="${h}" style="display:block;margin:6px 0">
    <polyline fill="none" stroke="#e67e22" stroke-width="1.5" points="${pts}" /></svg>`;
}

// Multi-line time-series plot (value vs seconds-from-start), dependency-free SVG.
// `markers` (optional) = array of absolute timestamps to flag as detected events.
function linePlot(t, seriesList, colors, labels, title, unit, markers = [], w = 300, h = 130) {
  if (!t || t.length < 2) return `<div class="muted">${title}: not enough samples</div>`;
  const pad = 26;
  const t0 = t[0];
  const xs = t.map((v) => v - t0);
  const xmax = Math.max(xs[xs.length - 1], 0.001);
  let ymin = Infinity, ymax = -Infinity;
  for (const s of seriesList) for (const v of s) { if (v < ymin) ymin = v; if (v > ymax) ymax = v; }
  if (!isFinite(ymin)) { ymin = -1; ymax = 1; }
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const X = (x) => pad + (x / xmax) * (w - 2 * pad);
  const Y = (y) => pad + (1 - (y - ymin) / (ymax - ymin)) * (h - 2 * pad);
  const lines = seriesList
    .map((s, i) => {
      const pts = s.map((v, j) => `${X(xs[j]).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
      return `<polyline fill="none" stroke="${colors[i]}" stroke-width="1" points="${pts}"/>`;
    })
    .join("");
  // Event markers: dashed vertical line + flag at the top.
  const marks = (markers || [])
    .map((mt) => {
      const x = X(mt - t0);
      return `<line x1="${x.toFixed(1)}" y1="${pad}" x2="${x.toFixed(1)}" y2="${h - pad}" stroke="#e74c3c" stroke-width="1" stroke-dasharray="3 2"/>` +
        `<polygon points="${(x - 3).toFixed(1)},${pad} ${(x + 3).toFixed(1)},${pad} ${x.toFixed(1)},${(pad + 5).toFixed(1)}" fill="#e74c3c"/>`;
    })
    .join("");
  const zeroY = ymin <= 0 && ymax >= 0 ? Y(0) : null;
  const legend = labels
    .map((l, i) => `<tspan fill="${colors[i]}" font-weight="700"> ${l}</tspan>`)
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="display:block;margin:4px 0;background:#fafbfc;border-radius:6px">
    <text x="${pad}" y="13" font-size="10" fill="#333">${title} (${unit})</text>
    <text x="${w - 4}" y="13" font-size="10" text-anchor="end">${legend}</text>
    ${zeroY !== null ? `<line x1="${pad}" y1="${zeroY.toFixed(1)}" x2="${w - pad}" y2="${zeroY.toFixed(1)}" stroke="#e3e3e3"/>` : ""}
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="#ccc"/>
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="#ccc"/>
    <text x="3" y="${pad + 4}" font-size="9" fill="#999">${ymax.toFixed(1)}</text>
    <text x="3" y="${h - pad}" font-size="9" fill="#999">${ymin.toFixed(1)}</text>
    <text x="${pad}" y="${h - 6}" font-size="9" fill="#999">0s</text>
    <text x="${w - pad}" y="${h - 6}" font-size="9" fill="#999" text-anchor="end">${xmax.toFixed(1)}s</text>
    ${marks}
    ${lines}
  </svg>`;
}

// Holds the raw passes for the open segment so the pass selector can re-render.
let rawPasses = [];

async function loadRawPlots(segmentKey) {
  const box = document.getElementById("rawPlots");
  if (!box) return;
  try {
    const raw = await (await fetch(`${API}/v1/segments/${segmentKey}/raw`)).json();
    rawPasses = raw.passes || [];
    if (!rawPasses.length) {
      box.innerHTML = `<span class="muted">No raw samples to plot.${raw.note ? " " + raw.note : ""}</span>`;
      return;
    }
    let selector = "";
    if (rawPasses.length > 1) {
      const opts = rawPasses
        .map((p, i) => `<option value="${i}">pass ${i + 1} of ${rawPasses.length}</option>`)
        .join("");
      selector = `<select onchange="window.__rsRenderPass(this.value)" style="margin:6px 0">${opts}</select>`;
    }
    box.innerHTML = selector + '<div id="rawPlotsInner"></div>';
    // Re-point renderPass at the inner div so the selector stays put.
    const inner = document.getElementById("rawPlotsInner");
    const draw = (i) => {
      const p = rawPasses[i];
      const im = p.imu;
      const eventTimes = (p.events || []).map((e) => e.t);
      const hitNote = eventTimes.length
        ? `<span class="muted"><span style="color:#e74c3c">▾</span> ${eventTimes.length} detected jolt${eventTimes.length > 1 ? "s" : ""}</span><br>`
        : "";
      inner.innerHTML =
        linePlot(im.t, [im.ax, im.ay, im.az], ["#e74c3c", "#27ae60", "#2a7de1"], ["ax", "ay", "az"], "Acceleration", "m/s²", eventTimes) +
        linePlot(im.t, [im.gx, im.gy, im.gz], ["#e67e22", "#8e44ad", "#16a085"], ["gx", "gy", "gz"], "Gyroscope", "rad/s") +
        hitNote +
        `<span class="muted">${p.n_samples} samples · ${new Date(p.ts * 1000).toLocaleString()}</span>`;
    };
    window.__rsRenderPass = (i) => draw(parseInt(i, 10));
    draw(0);
  } catch (err) {
    box.innerHTML = `<span class="muted">couldn't load sensor traces: ${err.message}</span>`;
  }
}

async function showDetail(segmentKey) {
  const el = document.getElementById("detail");
  el.style.display = "block";
  el.innerHTML = "loading…";
  try {
    const d = await (await fetch(`${API}/v1/segments/${segmentKey}`)).json();
    // History comes newest-first; reverse for a left-to-right time sparkline.
    const series = d.history.map((o) => o.roughness).reverse();
    el.innerHTML = `
      <span class="close" onclick="document.getElementById('detail').style.display='none'">✕</span>
      <h2>${d.severity_class} road</h2>
      <table>
        <tr><td>Pothole probability</td><td>${(d.pothole_probability * 100).toFixed(0)}%</td></tr>
        <tr><td>Intensity</td><td>${d.intensity_class} (${d.intensity_score.toFixed(1)})</td></tr>
        <tr><td>Avoidance (swerve rate)</td><td>${(d.swerve_rate * 100).toFixed(0)}%</td></tr>
        <tr><td>Hits / swerves</td><td>${d.n_hits.toFixed(1)} / ${d.n_swerves.toFixed(1)}</td></tr>
        <tr><td>Location ±</td><td>${d.location_spread_m.toFixed(0)} m</td></tr>
        <tr><td>Trend</td><td class="trend-${d.trend}">${d.trend}</td></tr>
        <tr><td>Roughness</td><td>${d.roughness_score.toFixed(2)}</td></tr>
        <tr><td>Confidence</td><td>${(d.confidence * 100).toFixed(0)}%</td></tr>
        <tr><td>Passes / devices</td><td>${d.n_passes} / ${d.n_devices}</td></tr>
      </table>
      ${sparkline(series)}
      <span class="muted">${d.history.length} passes · last ${new Date(d.last_seen).toLocaleString()}</span>
      <h2 style="margin-top:10px">Raw sensor traces</h2>
      <div id="rawPlots" class="muted">loading sensor traces…</div>
      <div style="margin-top:8px"><a href="${API}/v1/segments/${segmentKey}/raw" target="_blank">download raw sensor data →</a></div>`;
    loadRawPlots(segmentKey);
  } catch (err) {
    el.innerHTML = `<span class="muted">error: ${err.message}</span>`;
  }
}

async function refresh() {
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(",");
  const url = `${API}/v1/segments?bbox=${bbox}&min_confidence=${minConfidence}`;
  const status = document.getElementById("status");
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const geojson = await res.json();
    if (layer) layer.remove();
    layer = L.geoJSON(geojson, {
      style: (f) => styleFor(f.properties),
      onEachFeature: (f, l) =>
        l.on("click", () => showDetail(f.properties.segment_key)),
    }).addTo(map);
    status.textContent = `${geojson.features.length} segments`;
  } catch (err) {
    status.textContent = `error: ${err.message} (API: ${API})`;
  }
}

document.getElementById("conf").addEventListener("input", (e) => {
  minConfidence = parseFloat(e.target.value);
  document.getElementById("confVal").textContent = minConfidence.toFixed(2);
  refresh();
});
map.on("moveend", refresh);

// On load, fit the map to wherever the data actually is, so you see your drive
// regardless of the default centre. Falls back to a normal draw if there's none.
async function fitToData() {
  const status = document.getElementById("status");
  try {
    const geojson = await (await fetch(`${API}/v1/segments?min_confidence=0`)).json();
    if (geojson.features && geojson.features.length) {
      map.fitBounds(L.geoJSON(geojson).getBounds(), { maxZoom: 17, padding: [24, 24] });
      return; // fitBounds fires moveend -> refresh() draws
    }
    status.textContent = "no data yet — record a trip in the collector";
  } catch (err) {
    status.textContent = `error: ${err.message} (API: ${API})`;
  }
  refresh();
}
fitToData();
