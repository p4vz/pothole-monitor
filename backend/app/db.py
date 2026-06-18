"""Database engine + session. SQLite by default; point DATABASE_URL at Postgres
(with PostGIS) for production. Geometry is stored as plain lat/lng floats so the
schema is portable; the GeoJSON the viewer needs is derived from H3 cells, and a
PostGIS GIST index can be added on a generated geometry column in production."""
import os
import re

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings


def _resolve_database_url() -> str:
    """Pick the first NON-EMPTY source so a blank/placeholder var can't shadow a
    good one: explicit ROADSENSE_DATABASE_URL, then Railway's DATABASE_URL, then
    the configured default (SQLite)."""
    for val in (os.getenv("ROADSENSE_DATABASE_URL"), os.getenv("DATABASE_URL")):
        if val and val.strip():
            return val
    return settings.database_url


def _normalize_url(url: str) -> str:
    """Accept the standard URLs hosts hand out and route them to the installed
    driver. Railway/Heroku give `postgres://` or `postgresql://` (which SQLAlchemy
    maps to psycopg2); we ship psycopg v3, so force the `+psycopg` driver.
    Tolerate values pasted with surrounding quotes/whitespace."""
    url = url.strip().strip('"').strip("'").strip()
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


def _redact(url: str) -> str:
    """Hide the password so the URL is safe to print in logs."""
    return re.sub(r"://([^:/@]+):[^@]*@", r"://\1:***@", url)


_raw_url = _resolve_database_url()
database_url = _normalize_url(_raw_url)

if not database_url or "${{" in database_url:
    raise RuntimeError(
        "DATABASE_URL is empty or an unresolved Railway reference "
        f"(got {_raw_url!r}). On the backend service's Variables, "
        "set DATABASE_URL to your Postgres connection string — easiest via a "
        "reference variable like ${{Postgres.DATABASE_URL}} (the name before the "
        "dot must match your Postgres service), or paste the Postgres service's "
        "DATABASE_URL value directly."
    )

try:
    make_url(database_url)
except Exception as exc:  # malformed value (stray chars, bad format)
    raise RuntimeError(
        f"DATABASE_URL is set but is not a valid connection string. "
        f"The app received (password redacted): {_redact(database_url)!r}. "
        "Check for stray quotes, spaces, a trailing newline, or a malformed value."
    ) from exc

_connect_args = (
    {"check_same_thread": False} if database_url.startswith("sqlite") else {}
)

engine = create_engine(database_url, future=True, connect_args=_connect_args)
SessionLocal = sessionmaker(
    bind=engine, autoflush=False, expire_on_commit=False, future=True
)


class Base(DeclarativeBase):
    pass


def init_db() -> None:
    from . import models  # noqa: F401  (register mappers)

    Base.metadata.create_all(engine)
