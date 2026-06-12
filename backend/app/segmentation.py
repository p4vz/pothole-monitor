"""H3 hex-grid segmentation.

A segment is an H3 cell plus a heading bucket, so opposite directions of travel
(and roughly opposite lanes) map to distinct segments. Map-matching to OSM road
geometry is a planned Phase-3 upgrade that can replace the H3 key without
touching the rest of the pipeline.
"""
from __future__ import annotations

import math

import h3

from .config import settings


def heading_bucket(heading_deg: float, n: int | None = None) -> int:
    n = n or settings.heading_buckets
    if heading_deg is None or math.isnan(heading_deg):
        return 0
    return int((heading_deg % 360.0) / (360.0 / n)) % n


def segment_for(
    lat: float,
    lng: float,
    heading_deg: float,
    res: int | None = None,
    n_buckets: int | None = None,
) -> tuple[str, str, int]:
    """Return (segment_key, h3_index, heading_bucket)."""
    res = settings.h3_resolution if res is None else res
    cell = h3.latlng_to_cell(lat, lng, res)
    bucket = heading_bucket(heading_deg, n_buckets)
    return f"{cell}:{bucket}", cell, bucket


def cell_center(cell: str) -> tuple[float, float]:
    """(lat, lng) of the cell centroid."""
    return h3.cell_to_latlng(cell)


def cell_boundary_geojson(cell: str) -> list[list[float]]:
    """Closed [lng, lat] ring suitable for a GeoJSON Polygon."""
    ring = [[lng, lat] for (lat, lng) in h3.cell_to_boundary(cell)]
    if ring and ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring
