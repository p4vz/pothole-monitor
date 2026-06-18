"""Rebuild all derived data (observations + segment state) from the immutable
raw batches. Use after an algorithm change, or to backfill new fields (e.g.
per-segment sample ranges) on data ingested by an older build.

    python -m scripts.reprocess

Requires the raw blobs to still exist in storage (set ROADSENSE_STORAGE_DIR to a
persistent volume in production). Reports how many were missing.
"""
from __future__ import annotations

from app.db import init_db
from app.schema_sync import ensure_columns
from app.pipeline import reprocess_all


def main() -> None:
    init_db()
    ensure_columns()
    result = reprocess_all()
    print(
        f"reprocessed {result['reprocessed']}/{result['total']} batches "
        f"(missing raw: {result['missing_raw']}, failed: {result['failed']})"
    )


if __name__ == "__main__":
    main()
