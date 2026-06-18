"""Cluster localized jolt points into physical road defects.

A defect is defined by the *data* — where independent passes actually felt a
jolt — not by the H3 aggregation grid or heading buckets. We bin event points
into fine H3 cells (~3.5 m), connect occupied cells within a small k-ring via
union-find, and treat each connected component as one defect. Dependency-light:
only h3 + numpy, no clustering libraries.
"""
from __future__ import annotations

import math

import h3

from .config import settings


def _meters_between(lat1, lng1, lat2, lng2) -> float:
    mlat = 111_111.0
    mlng = 111_111.0 * math.cos(math.radians((lat1 + lat2) / 2.0))
    return math.hypot((lat1 - lat2) * mlat, (lng1 - lng2) * mlng)


class _UnionFind:
    def __init__(self):
        self.parent: dict = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def cluster_defects(points: list, cfg=settings) -> list[dict]:
    """Group event points into defects.

    `points` is any iterable of objects/dicts exposing lat, lng, device_id,
    severity, value. Returns a list of defect dicts:
      {lat, lng, severity, intensity, n_points, n_devices, n_directions,
       confidence, radius_m}
    """
    def attr(p, name):
        return p[name] if isinstance(p, dict) else getattr(p, name)

    pts = [
        (
            float(attr(p, "lat")),
            float(attr(p, "lng")),
            str(attr(p, "device_id")),
            int(attr(p, "severity")),
            abs(float(attr(p, "value"))),
            int(attr(p, "heading_bucket")),
        )
        for p in points
    ]
    if not pts:
        return []

    res = cfg.defect_cluster_res
    k = cfg.defect_cluster_k
    # Bin each point into a fine cell, then union cells that fall within each
    # other's k-ring (so a jolt straddling a cell edge still merges).
    cell_of = [h3.latlng_to_cell(la, ln, res) for (la, ln, *_rest) in pts]
    occupied = set(cell_of)
    uf = _UnionFind()
    for cell in occupied:
        uf.find(cell)
        for nb in h3.grid_disk(cell, k):
            if nb in occupied:
                uf.union(cell, nb)

    groups: dict[str, list[int]] = {}
    for i, cell in enumerate(cell_of):
        groups.setdefault(uf.find(cell), []).append(i)

    defects: list[dict] = []
    for root, idxs in groups.items():
        members = [pts[i] for i in idxs]
        # Weight the centroid by jolt magnitude (stronger hits are better
        # localized) to pull the marker toward the true defect.
        wsum = sum(m[4] for m in members) or float(len(members))
        clat = sum(m[0] * (m[4] or 1.0) for m in members) / wsum
        clng = sum(m[1] * (m[4] or 1.0) for m in members) / wsum
        devices = {m[2] for m in members}
        directions = {m[5] for m in members}
        n_dev = len(devices)
        # Spread = RMS distance of members from the centroid (GPS scatter).
        radius = math.sqrt(
            sum(_meters_between(clat, clng, m[0], m[1]) ** 2 for m in members) / len(members)
        )
        # Confidence rises with independent (distinct-device) evidence.
        confidence = 1.0 - 0.5 ** n_dev
        defects.append(
            {
                "id": str(root),  # stable cluster id (union-find root cell)
                "lat": round(clat, 7),
                "lng": round(clng, 7),
                "severity": max(m[3] for m in members),
                "intensity": round(sum(m[4] for m in members) / len(members), 3),
                "n_points": len(members),
                "n_devices": n_dev,
                "n_directions": len(directions),
                "confidence": round(confidence, 3),
                "radius_m": round(radius, 1),
            }
        )
    defects.sort(key=lambda d: (d["severity"], d["n_devices"], d["intensity"]), reverse=True)
    return defects
