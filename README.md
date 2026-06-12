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
| [`backend/`](backend/) | Ingestion + analysis + aggregation + read API | **Implemented & tested** (12 tests, runs on SQLite + local FS) |
| [`viewer/`](viewer/) | Static web map colouring road condition | Implemented (keyless Leaflet/OSM) |
| [`collector/`](collector/) | RN/Expo app: log + buffer + upload | Skeleton (core data path) |

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

Design rationale and the phased roadmap live in the planning doc; the legacy
root `index.html`/`app.js` is the original single-page pothole prototype that
seeded this project.

## Roadmap (next)

OSM map-matching to replace H3 · supervised ML classifier trained on collected
data · vector tiles · trip privacy trimming. See each component's README.
