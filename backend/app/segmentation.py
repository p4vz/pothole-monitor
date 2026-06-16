"""H3 hex-grid segmentation.

A segment is an H3 cell plus a heading bucket, so opposite directions of travel
(and roughly opposite lanes) map to distinct segments. The cell resolution
(settings.h3_resolution, ~25 m at res 11) is deliberately coarser than GPS noise
so repeat passes reinforce one segment; the precise pothole comes from the
Bayesian sub-cell location and event clustering, not the cell.

Deferred upgrade — OSM map-matching (planned, not built):
    This module is the single seam for "what counts as the same place". A
    map-matched variant would snap the whole GPS trace to road centerlines and
    key segments by (edge_id, distance_along_bucket, direction) instead of an H3
    cell — making registration lane- and lag-invariant. It operates on the trace
    (a sequence), so analyze() would match once per batch and assign each window
    to its matched edge+offset; aggregation/Bayesian/clustering stay unchanged.
    Backend options: hosted OSRM `/match` or Valhalla `/trace_attributes` (needs
    an outbound egress allowlist) vs a self-hosted/offline OSM extract.
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
