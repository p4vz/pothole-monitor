# RoadSense backend

Ingests raw IMU/GPS batches from the mobile collector, runs a heuristic analysis
pipeline, and aggregates many passes/devices into a continuously-updated
"state of the road" served as GeoJSON to the web viewer.

```
collector → POST /v1/batches → object storage (raw, immutable)
                             → raw_batches (metadata) → enqueue
                                                          → worker:
                                                            analyze → observations
                                                            → fold → segment_state
viewer ← GET /v1/segments (GeoJSON) ←──────────────────────────────┘
```

## Run locally (zero external services)

```bash
cd backend
python3 -m pip install -r requirements.txt
python3 -m pytest -q                      # 12 tests: analysis, aggregation, API
uvicorn app.main:app --reload             # http://127.0.0.1:8000/docs
```

Dev uses **SQLite** (`roadsense.db`) and a **local filesystem** object store
(`_storage/`). Analysis runs in a FastAPI background task — no Redis needed.

## API

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/devices` | Anonymous device registration → `{device_id, token}` |
| `POST` | `/v1/batches` | Upload a gzipped batch (idempotent on `batch_id`); 202 + ack |
| `GET`  | `/v1/segments?bbox=&min_confidence=` | Segment-state GeoJSON for the viewer |
| `GET`  | `/v1/segments/{key}` | Segment detail + observation history |
| `GET`  | `/healthz` | Liveness |

Collector requests send `X-Device-Token`. Batch body is `BatchUpload` JSON,
optionally gzipped (`Content-Encoding: gzip`).

## How the analysis works (`app/analysis.py`)

1. **Align** 1 Hz GPS onto the 50 Hz IMU clock (circular interp for heading).
2. **Reorient** for arbitrary phone mounting: estimate gravity (low-pass),
   remove it, project onto the road-normal (gravity) axis.
3. **Gate** out idle/over-speed/poor-GPS samples.
4. **Window** the vertical acceleration; per window compute roughness (RMS) and
   detect defect events (peaks above threshold → small/medium/large).
5. **Segment** each window to an H3 cell + heading bucket and collapse windows
   into one observation per (segment, pass).

## How aggregation works (`app/aggregation.py`)

Each observation folds into `segment_state`:

- **Roughness** = recency-decayed running mean (capped effective-sample EWMA →
  stays adaptive; old data decays so a **repaved road heals**).
- **Defect probability** = Beta(α, β) posterior — a detected pass adds to α, a
  clean pass to β, both recency-decayed.
- **Confidence** rises with accumulated evidence and is attenuated by the number
  of **distinct devices** (single device caps at 0.5), so independent agreement
  counts more than one person repeating a route.

Raw blobs + per-pass observations are retained so the pipeline can be re-run/
backfilled as the algorithm improves (e.g. the planned ML upgrade).

## Production deployment (Railway / Render / Fly)

Services: `web` (API) + `worker` (RQ) + Postgres/PostGIS + Redis + object store.

```bash
pip install -r requirements-prod.txt
export ROADSENSE_DATABASE_URL=postgresql+psycopg://...   # PostGIS instance
export ROADSENSE_USE_RQ=1 ROADSENSE_REDIS_URL=redis://...
# object storage: implement an S3/R2 backend in app/storage.py:get_store()
```

`Procfile` defines both process types. Swaps are config-only — no pipeline code
changes. See `app/config.py` for all tunable knobs and `.env.example`.

## Layout

```
app/
  config.py         settings (env-overridable)
  db.py models.py   SQLAlchemy schema (SQLite dev / PostGIS prod)
  storage.py        immutable raw-blob store (local FS dev / S3 prod)
  schemas.py        API request/response models
  segmentation.py   H3 cell + heading bucket
  analysis.py       signal pipeline (pure NumPy)
  aggregation.py    multi-pass folding (decay, Beta, confidence)
  pipeline.py       raw blob → observations → segment_state
  queue.py worker.py  in-process (dev) / RQ (prod) dispatch
  main.py           FastAPI ingestion + read API
tests/              analysis / aggregation / API + synthetic signal generator
```
