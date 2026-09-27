"""Joint names and software limits for the one SO-101 arm."""

from __future__ import annotations

from typing import Any

JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
WRIST_ROLL_CAP = 172.0


def limits_from_calibration(calibration: dict[str, Any] | None) -> dict[str, tuple[float, float]]:
    """Degrees around the calibrated midpoint. Wrist roll is capped to avoid the ±180 wrap."""
    out: dict[str, tuple[float, float]] = {"gripper": (0.0, 100.0)}
    if not calibration:
        for joint in JOINTS:
            if joint != "gripper":
                out[joint] = (-90.0, 90.0)
        return out
    for joint in JOINTS:
        if joint == "gripper":
            continue
        entry = calibration.get(joint)
        if entry is None:
            out[joint] = (-90.0, 90.0)
            continue
        if hasattr(entry, "range_min"):
            range_min, range_max = float(entry.range_min), float(entry.range_max)
        else:
            range_min, range_max = float(entry["range_min"]), float(entry["range_max"])
        half = (range_max - range_min) / 2 * 360 / 4095
        if joint == "wrist_roll":
            half = min(half, WRIST_ROLL_CAP)
        out[joint] = (-half + 3.0, half - 3.0)
    return out
