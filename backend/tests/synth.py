"""Synthetic IMU/GPS batch generator for deterministic tests.

Simulates a vehicle driving in a straight line at constant speed/heading, with a
phone resting roughly flat (gravity on +z) plus road-noise on the vertical axis,
and optional pothole impulses.
"""
from __future__ import annotations

import math

import numpy as np

G = 9.81


def make_batch(
    batch_id: str,
    device_id: str,
    start_t: float = 1_700_000_000.0,
    lat0: float = 52.370,
    lng0: float = 4.900,
    heading_deg: float = 90.0,   # east
    speed_mps: float = 13.0,     # ~47 km/h
    duration_s: float = 12.0,
    fs: int = 50,
    noise_std: float = 0.15,     # smooth-road vertical noise
    potholes: list[tuple[float, float]] | None = None,  # (t_offset_s, magnitude m/s^2)
    swerves: list[tuple[float, float]] | None = None,    # (t_offset_s, yaw_rate rad/s) out-and-back
    turns: list[tuple[float, float]] | None = None,      # (t_offset_s, yaw_rate) sustained one-way
    gps_acc: float = 5.0,
    seed: int = 0,
) -> dict:
    rng = np.random.default_rng(seed)
    n = int(duration_s * fs)
    t = start_t + np.arange(n) / fs

    # Vertical road-normal linear acceleration: noise + impulses.
    vert = rng.normal(0.0, noise_std, n)
    for t_off, mag in potholes or []:
        i = int(t_off * fs)
        if 0 <= i < n:
            # short biphasic impulse
            vert[i] += mag
            if i + 1 < n:
                vert[i + 1] -= mag * 0.6

    az = G + vert            # gravity on z + vertical motion
    ax = rng.normal(0.0, 0.05, n)
    ay = rng.normal(0.0, 0.05, n)
    # Gyro: gravity is on +z, so yaw rate (steering) lives on the z gyro axis.
    gz = rng.normal(0.0, 0.01, n)

    half = max(1, int(0.4 * fs))
    # A swerve: steer one way then back (yaw +then-) with a lateral accel bump,
    # and NO vertical jerk (the driver avoided the hole).
    for t_off, yaw in swerves or []:
        i = int(t_off * fs)
        gz[max(0, i - half):i] += yaw          # steer out
        gz[i:min(n, i + half)] -= yaw          # steer back
        ax[max(0, i - half):min(n, i + half)] += 0.6 * yaw * speed_mps  # lateral accel

    # A steady turn: sustained yaw in ONE direction (must NOT look like a swerve).
    for t_off, yaw in turns or []:
        i = int(t_off * fs)
        gz[max(0, i - half):min(n, i + half)] += yaw

    # GPS at 1 Hz advancing along heading.
    hb = math.radians(heading_deg)
    gps = []
    for k in range(int(duration_s) + 1):
        d = speed_mps * k
        dlat = (d * math.cos(hb)) / 111_111.0
        dlng = (d * math.sin(hb)) / (111_111.0 * math.cos(math.radians(lat0)))
        gps.append(
            {
                "t": start_t + k,
                "lat": lat0 + dlat,
                "lng": lng0 + dlng,
                "speed": speed_mps,
                "heading": heading_deg,
                "acc": gps_acc,
            }
        )

    return {
        "batch_id": batch_id,
        "meta": {"session_id": f"sess-{device_id}", "sample_rate": fs},
        "imu": {
            "t": t.tolist(),
            "ax": ax.tolist(),
            "ay": ay.tolist(),
            "az": az.tolist(),
            "gx": np.zeros(n).tolist(),
            "gy": np.zeros(n).tolist(),
            "gz": gz.tolist(),
        },
        "gps": gps,
    }
