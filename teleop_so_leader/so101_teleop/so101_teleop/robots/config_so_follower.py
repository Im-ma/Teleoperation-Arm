from dataclasses import dataclass, field

from so101_teleop.cameras import CameraConfig

from .config import RobotConfig


@dataclass
class SOFollowerConfig:
    port: str
    disable_torque_on_disconnect: bool = True
    max_relative_target: float | dict[str, float] | None = None
    cameras: dict[str, CameraConfig] = field(default_factory=dict)
    use_degrees: bool = True
    position_p_coefficient: int = 16
    position_i_coefficient: int = 0
    position_d_coefficient: int = 32
    num_read_retries: int = 2


@dataclass
class SOFollowerRobotConfig(RobotConfig, SOFollowerConfig):
    pass


SO100FollowerConfig = SOFollowerRobotConfig
SO101FollowerConfig = SOFollowerRobotConfig
