from dataclasses import dataclass

from .config import TeleoperatorConfig


@dataclass
class SOLeaderConfig:
    port: str
    use_degrees: bool = True
    num_read_retries: int = 2


@dataclass
class SOLeaderTeleopConfig(TeleoperatorConfig, SOLeaderConfig):
    pass


SO100LeaderConfig = SOLeaderTeleopConfig
SO101LeaderConfig = SOLeaderTeleopConfig
