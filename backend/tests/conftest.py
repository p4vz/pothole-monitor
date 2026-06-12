"""Test fixtures. Sets env BEFORE importing app modules so settings bind to a
temp SQLite DB and a temp storage dir per test session.
"""
import os
import sys
import tempfile
from pathlib import Path

# Make `app` and `tests` importable.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_tmp = tempfile.mkdtemp(prefix="roadsense-test-")
os.environ["ROADSENSE_DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["ROADSENSE_STORAGE_DIR"] = f"{_tmp}/storage"

import pytest  # noqa: E402

from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.db import Base  # noqa: E402


@pytest.fixture()
def db():
    # Fresh schema per test for isolation.
    Base.metadata.drop_all(engine)
    init_db()
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
