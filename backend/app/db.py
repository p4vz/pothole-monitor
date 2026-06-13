"""Database engine + session. SQLite by default; point DATABASE_URL at Postgres
(with PostGIS) for production. Geometry is stored as plain lat/lng floats so the
schema is portable; the GeoJSON the viewer needs is derived from H3 cells, and a
PostGIS GIST index can be added on a generated geometry column in production."""
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings


def _normalize_url(url: str) -> str:
    """Accept the standard URLs hosts hand out and route them to the installed
    driver. Railway/Heroku give `postgres://` or `postgresql://` (which SQLAlchemy
    maps to psycopg2); we ship psycopg v3, so force the `+psycopg` driver."""
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


database_url = _normalize_url(settings.database_url)

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
