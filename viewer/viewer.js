// RoadSense viewer — reads segment-state GeoJSON and colours H3 hexes by
// condition (colour = severity, opacity = confidence). Keyless OSM tiles.
//
// Override the API base with ?api=https://your-backend.
// Defaults to the deployed Railway API; use ?api=http://127.0.0.1:8000 for local.
const API =
  new URLSearchParams(location.search).get("api") ||
  "https://pothole-monitor-production.up.railway.app";

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

function popupHtml(p) {
  return `<b>${p.severity_class}</b> (roughness ${p.roughness_score})<br>
    defect prob: ${(p.defect_probability * 100).toFixed(0)}%<br>
    confidence: ${(p.confidence * 100).toFixed(0)}%<br>
    passes: ${p.n_passes} · devices: ${p.n_devices}<br>
    <span class="muted">updated ${new Date(p.last_seen).toLocaleString()}</span>`;
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
      onEachFeature: (f, l) => l.bindPopup(popupHtml(f.properties)),
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
refresh();
