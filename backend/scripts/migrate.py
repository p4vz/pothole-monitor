"""Manual schema migration: add columns introduced after the DB was created.

The backend also runs this automatically on startup (app.schema_sync), so this
script is only needed if you want to apply it out-of-band.

    python -m scripts.migrate
"""
from __future__ import annotations

from app.db import init_db
from app.schema_sync import ensure_columns


def migrate() -> None:
    init_db()  # create any missing tables first
    added = ensure_columns(verbose=True)
    print(f"migration complete ({added} columns added)." if added else "schema up to date — no columns to add.")


if __name__ == "__main__":
    migrate()
