"""Idempotently add columns introduced after a table was first created.

SQLAlchemy's create_all() never ALTERs existing tables, so a database created by
an earlier deploy is missing newer columns — and any query that maps them fails
(e.g. a 500 on the segment-detail endpoint). This adds any missing columns in
place, with no data loss, and is safe to run on every startup. Dialect-agnostic
(works on SQLite and Postgres): we inspect first and only ADD what's missing.
"""
from __future__ import annotations

from sqlalchemy import inspect, text

from .db import engine

# table -> {column: DDL type}. Keep in sync with models.py as columns are added.
NEW_COLUMNS_BY_TABLE: dict[str, dict[str, str]] = {
    "segment_state": {
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
    },
    "segment_observations": {
        "sample_start": "INTEGER DEFAULT 0",
        "sample_end": "INTEGER DEFAULT 0",
    },
}


def ensure_columns(verbose: bool = False) -> int:
    """Add any missing columns to existing tables. Returns the count added."""
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    added = 0
    for table, columns in NEW_COLUMNS_BY_TABLE.items():
        if table not in tables:
            continue  # create_all() will make it fresh with all columns
        existing = {c["name"] for c in inspector.get_columns(table)}
        missing = {k: v for k, v in columns.items() if k not in existing}
        if not missing:
            continue
        with engine.begin() as conn:
            for name, ddl in missing.items():
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
                if verbose:
                    print(f"added {table}.{name}")
        added += len(missing)
    return added
