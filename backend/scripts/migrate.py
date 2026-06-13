"""Idempotent schema migration for the Bayesian pothole fields.

`init_db()` (create_all) adds *new tables* but never alters existing ones, so a
Postgres database created before the Bayesian model gained its columns needs
them backfilled. This adds any missing columns to `segment_state` in place,
without touching data. Safe to run repeatedly.

    python -m scripts.migrate

SQLite (local/dev) recreates the schema from scratch via init_db(), so this is
primarily for the deployed Postgres.
"""
from __future__ import annotations

from sqlalchemy import inspect, text

from app.db import engine, init_db

# column name -> SQL type (Postgres / SQLite compatible)
NEW_COLUMNS = {
    "pothole_probability": "DOUBLE PRECISION DEFAULT 0",
    "ex_log_odds": "DOUBLE PRECISION DEFAULT 0",
    "intensity_score": "DOUBLE PRECISION DEFAULT 0",
    "intensity_mean": "DOUBLE PRECISION DEFAULT 0",
    "intensity_var": "DOUBLE PRECISION DEFAULT 0",
    "intensity_class": "VARCHAR DEFAULT 'none'",
    "swerve_rate": "DOUBLE PRECISION DEFAULT 0",
    "n_hits": "DOUBLE PRECISION DEFAULT 0",
    "n_swerves": "DOUBLE PRECISION DEFAULT 0",
    "n_clears": "DOUBLE PRECISION DEFAULT 0",
    "loc_lat": "DOUBLE PRECISION DEFAULT 0",
    "loc_lng": "DOUBLE PRECISION DEFAULT 0",
    "loc_var_m2": "DOUBLE PRECISION DEFAULT 0",
    "loc_weight": "DOUBLE PRECISION DEFAULT 0",
}


def migrate() -> None:
    init_db()  # create any missing tables first
    inspector = inspect(engine)
    if "segment_state" not in inspector.get_table_names():
        print("segment_state table absent — created fresh by init_db(); nothing to migrate.")
        return
    existing = {c["name"] for c in inspector.get_columns("segment_state")}
    missing = {k: v for k, v in NEW_COLUMNS.items() if k not in existing}
    if not missing:
        print("schema up to date — no columns to add.")
        return
    with engine.begin() as conn:
        for name, ddl in missing.items():
            conn.execute(text(f"ALTER TABLE segment_state ADD COLUMN {name} {ddl}"))
            print(f"added segment_state.{name}")
    print(f"migration complete ({len(missing)} columns added).")


if __name__ == "__main__":
    migrate()
