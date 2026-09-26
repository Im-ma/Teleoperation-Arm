import abc
import json
from pathlib import Path
from typing import Any

from so101_teleop.constants import CALIBRATION_DIR, TELEOPERATORS
from so101_teleop.motors.motors_bus import MotorCalibration
from so101_teleop.types import RobotAction

from .config import TeleoperatorConfig


def _calibration_from_json(data: dict) -> dict[str, MotorCalibration]:
    return {name: MotorCalibration(**values) for name, values in data.items()}


class Teleoperator(abc.ABC):
    config_class: type[TeleoperatorConfig]
    name: str

    def __init__(self, config: TeleoperatorConfig):
        self.id = config.id
        self.calibration_dir = (
            config.calibration_dir
            if config.calibration_dir
            else CALIBRATION_DIR / TELEOPERATORS / self.name
        )
        self.calibration_dir.mkdir(parents=True, exist_ok=True)
        self.calibration_fpath = self.calibration_dir / f"{self.id}.json"
        self.calibration: dict[str, MotorCalibration] = {}
        if self.calibration_fpath.is_file():
            self._load_calibration()

    def __str__(self) -> str:
        return f"{self.id} {self.__class__.__name__}"

    def _load_calibration(self, fpath: Path | None = None) -> None:
        fpath = self.calibration_fpath if fpath is None else fpath
        with open(fpath) as f:
            self.calibration = _calibration_from_json(json.load(f))

    def _save_calibration(self, fpath: Path | None = None) -> None:
        fpath = self.calibration_fpath if fpath is None else fpath
        payload = {name: vars(cal) for name, cal in self.calibration.items()}
        with open(fpath, "w") as f:
            json.dump(payload, f, indent=4)

    @property
    @abc.abstractmethod
    def action_features(self) -> dict: ...

    @property
    @abc.abstractmethod
    def feedback_features(self) -> dict: ...

    @property
    @abc.abstractmethod
    def is_connected(self) -> bool: ...

    @abc.abstractmethod
    def connect(self, calibrate: bool = True) -> None: ...

    @property
    @abc.abstractmethod
    def is_calibrated(self) -> bool: ...

    @abc.abstractmethod
    def calibrate(self) -> None: ...

    @abc.abstractmethod
    def configure(self) -> None: ...

    @abc.abstractmethod
    def get_action(self) -> RobotAction: ...

    @abc.abstractmethod
    def send_feedback(self, feedback: dict[str, Any]) -> None: ...

    @abc.abstractmethod
    def disconnect(self) -> None: ...
