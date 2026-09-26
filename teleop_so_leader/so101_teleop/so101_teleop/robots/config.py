from dataclasses import dataclass
from pathlib import Path


@dataclass(kw_only=True)
class RobotConfig:
    id: str | None = None
    calibration_dir: Path | None = None

    def __post_init__(self) -> None:
        if hasattr(self, "cameras") and self.cameras:
            for _, config in self.cameras.items():
                for attr in ["width", "height", "fps"]:
                    if getattr(config, attr) is None:
                        raise ValueError(
                            f"Specifying '{attr}' is required for the camera to be used in a robot"
                        )

    @property
    def type(self) -> str:
        return "so101_follower"
