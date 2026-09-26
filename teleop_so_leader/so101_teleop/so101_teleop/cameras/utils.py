from .camera import Camera
from .configs import CameraConfig


def make_cameras_from_configs(camera_configs: dict[str, CameraConfig]) -> dict[str, Camera]:
    if camera_configs:
        raise ValueError(
            "This isolated SO-101 kit runs teleoperation without cameras. "
            "Leave cameras empty. Use the full LeRobot repo if you need OpenCV/RealSense display."
        )
    return {}
