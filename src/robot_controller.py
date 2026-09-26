from __future__ import annotations

from dataclasses import dataclass


def _map_range(value: float, in_min: float, in_max: float, out_min: float, out_max: float) -> float:
    value = max(in_min, min(in_max, value))
    ratio = (value - in_min) / (in_max - in_min)
    return out_min + ratio * (out_max - out_min)


@dataclass
class RobotState:
    connected: bool = False
    active: bool = False
    base_deg: float = 90.0
    shoulder_deg: float = 90.0
    gripper_closed: bool = False


class MockRobotController:
    """Safe controller for UI/camera development before physical-arm integration."""

    def __init__(self, smoothing: float = 0.2) -> None:
        self.state = RobotState(connected=True)
        self.smoothing = smoothing

    def start(self) -> None:
        self.state.active = True

    def stop(self) -> None:
        self.state.active = False

    def update_from_hand(self, x: float, y: float, pinching: bool) -> RobotState:
        if not self.state.active:
            return self.state

        target_base = _map_range(x, 0.15, 0.85, 35.0, 145.0)
        target_shoulder = _map_range(1.0 - y, 0.15, 0.85, 45.0, 135.0)

        self.state.base_deg += self.smoothing * (target_base - self.state.base_deg)
        self.state.shoulder_deg += self.smoothing * (
            target_shoulder - self.state.shoulder_deg
        )
        self.state.gripper_closed = pinching
        return self.state


# Physical SO-ARM101 integration goes here after the arm is confirmed on the laptop.
