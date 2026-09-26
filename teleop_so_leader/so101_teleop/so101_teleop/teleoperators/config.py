from dataclasses import dataclass
from pathlib import Path


@dataclass(kw_only=True)
class TeleoperatorConfig:
    id: str | None = None
    calibration_dir: Path | None = None

    @property
    def type(self) -> str:
        return "so101_leader"
