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
      <span class="muted">${d.history.length} passes · last ${new Date(d.last_seen).toLocaleString()}</span>`;
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
