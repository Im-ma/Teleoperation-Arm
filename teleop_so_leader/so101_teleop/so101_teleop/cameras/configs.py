from dataclasses import dataclass


@dataclass(kw_only=True)
class CameraConfig:
    fps: int | None = None
    width: int | None = None
    height: int | None = None

    @property
    def type(self) -> str:
        return "camera"
