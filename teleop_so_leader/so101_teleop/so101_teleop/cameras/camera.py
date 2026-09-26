import abc
from typing import Any, Protocol, runtime_checkable

from .configs import CameraConfig


class Camera(abc.ABC):
    def __init__(self, config: CameraConfig):
        self.fps = config.fps
        self.width = config.width
        self.height = config.height

    @property
    @abc.abstractmethod
    def is_connected(self) -> bool: ...

    @abc.abstractmethod
    def connect(self, warmup: bool = True) -> None: ...

    @abc.abstractmethod
    def disconnect(self) -> None: ...

    def read_latest(self, max_age_ms: int = 500) -> Any:
        raise NotImplementedError


@runtime_checkable
class DepthCamera(Protocol):
    use_depth: bool

    def read_latest_depth(self, max_age_ms: int = 500) -> Any: ...
