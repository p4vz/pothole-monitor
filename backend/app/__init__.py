"""RoadSense backend — crowdsourced road-condition sensing platform.

Tiers:
  * Ingestion API (FastAPI) — stores raw IMU/GPS batches immutably, enqueues work.
  * Analysis worker — turns raw signals into per-segment observations.
  * Aggregation — folds observations from many passes/devices into segment state.
  * Read API — serves segment state as GeoJSON for the web viewer.

Runs anywhere on SQLite + local filesystem; production swaps PostGIS / Redis /
object storage via environment variables (see config.Settings and README).
"""
