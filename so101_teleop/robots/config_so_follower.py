from dataclasses import dataclass

from .config import RobotConfig


@dataclass
class SOFollowerConfig:
    port: str
    disable_torque_on_disconnect: bool = True
    max_relative_target: float | dict[str, float] | None = None
    use_degrees: bool = True
    position_p_coefficient: int = 16
    position_i_coefficient: int = 0
    position_d_coefficient: int = 32
    num_read_retries: int = 2


@dataclass
class SOFollowerRobotConfig(RobotConfig, SOFollowerConfig):
    pass


SO101FollowerConfig = SOFollowerRobotConfig
