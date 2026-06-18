"""Immutable object storage for raw batch blobs.

LocalObjectStore (filesystem) is the dev default. Swap in an S3/R2 backend in
production by implementing the same put/get/exists interface and selecting it in
get_store(); nothing else in the pipeline changes.
"""
from __future__ import annotations

import os
from pathlib import Path

from .config import settings


class LocalObjectStore:
    def __init__(self, base_dir: str) -> None:
        self.base = Path(base_dir)
        self.base.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        p = self.base / key
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def put(self, key: str, data: bytes) -> str:
        with open(self._path(key), "wb") as f:
            f.write(data)
        return key

    def get(self, key: str) -> bytes:
        with open(self._path(key), "rb") as f:
            return f.read()

    def exists(self, key: str) -> bool:
        return os.path.exists(self._path(key))


_store: LocalObjectStore | None = None


def get_store() -> LocalObjectStore:
    global _store
    if _store is None:
        _store = LocalObjectStore(settings.storage_dir)
    return _store
