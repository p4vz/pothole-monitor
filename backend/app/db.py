"""Database engine + session. SQLite by default; point DATABASE_URL at Postgres
(with PostGIS) for production. Geometry is stored as plain lat/lng floats so the
schema is portable; the GeoJSON the viewer needs is derived from H3 cells, and a
PostGIS GIST index can be added on a generated geometry column in production."""
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings

_connect_args = (
    {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
)

engine = create_engine(settings.database_url, future=True, connect_args=_connect_args)
SessionLocal = sessionmaker(
    bind=engine, autoflush=False, expire_on_commit=False, future=True
)


class Base(DeclarativeBase):
    pass


def init_db() -> None:
    from . import models  # noqa: F401  (register mappers)

    Base.metadata.create_all(engine)
