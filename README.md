# RoadSense — crowdsourced road-condition sensing

Phones log raw inertial + GPS data while driving; a server stores the raw data
immutably, analyses it into per-segment roughness/defect signals, and aggregates
many passes from many people into one continuously-updated **state of the road**,
rendered on a map.

```
collector (React Native)  ──gzipped IMU+GPS batches──▶  backend (FastAPI + worker)
   50 Hz IMU, 1 Hz GPS                                    raw → analyse → aggregate
   SQLite buffer, offline-safe                            H3 segments + Beta confidence
                                                                    │
viewer (Leaflet + OSM)  ◀──── GET /v1/segments (GeoJSON) ───────────┘
```

## Components

| Dir | What | Status |
|-----|------|--------|
| [`backend/`](backend/) | Ingestion + analysis + Bayesian aggregation + read API + ML | **Implemented & tested** (23 tests, runs on SQLite + local FS) |
| `index.html` / `app.js` | **Web collector** — logs motion+GPS in-browser, uploads to backend | Implemented (no app install needed) |
| [`viewer/`](viewer/) | Static web map + segment detail/history panel | Implemented (keyless Leaflet/OSM) |
| [`collector/`](collector/) | Native RN/Expo collector (alternative to the web one) | Skeleton (core data path) |

## Quick start

```bash
# Backend
cd backend && python3 -m pip install -r requirements.txt
python3 -m pytest -q                 # 12 passing
uvicorn app.main:app --reload        # http://127.0.0.1:8000/docs

# Viewer (serve statically, points at 127.0.0.1:8000 by default)
cd ../viewer && python3 -m http.server 5500   # open http://localhost:5500
```

## How it answers the design goals

- **Local logging → batched upload → raw stored:** collector buffers to SQLite
  and uploads gzipped batches; backend archives the raw blob immutably before any
  analysis, so the pipeline can be re-run as algorithms improve.
- **Analysis:** heuristic v1 — reorient for arbitrary phone mounting, speed-gate,
  window the vertical acceleration, detect roughness + defect events. Window
  features are ML-ready for a later supervised upgrade.
- **Aggregation across people & repeats:** each pass folds into an H3 segment via a
  recency-decayed roughness mean (roads **heal** after repaving) and a Beta defect
  posterior; confidence rises with **distinct devices**, so independent agreement
  outweighs one person repeating a route.
- **Bayesian hit + swerve inference:** big potholes show up as *both* vertical jerk
  (drivers who hit) and lateral/yaw evasion (drivers who steer around). The model
  classifies each pass as hit / swerve / clear and fuses them, so a pothole most
  people avoid — which roughness alone reads as "smooth" — is still flagged with
  high probability and a swerve-inflated intensity, plus a sub-cell location estimate.

Design rationale and the phased roadmap live in the planning doc; the legacy
root `index.html`/`app.js` is the original single-page pothole prototype that
seeded this project.

## Roadmap status

Built: ingestion + immutable raw storage, heuristic analysis, H3 segmentation,
multi-pass aggregation (distinct-device confidence, recency healing, trend),
read API + viewer with detail/history, opt-in privacy trip-trimming, and a
data-ready ML defect model (heuristic fallback until trained on real labels).

Deferred by design: **OSM map-matching** (H3 is sufficient until there's real
data to evaluate against) and **vector tiles** (a scale optimisation). The
natural next step is operational — collect real drives, then retrain the model
(`backend/scripts/train_model.py`) and revisit map-matching with data in hand.
