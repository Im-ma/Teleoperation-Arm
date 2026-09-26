"""Download the MediaPipe pose/hand models used by the website."""

from __future__ import annotations

import urllib.request
from pathlib import Path

MODELS = {
    "pose_landmarker_full.task": (
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
        "pose_landmarker_full/float16/latest/pose_landmarker_full.task"
    ),
    "pose_landmarker_heavy.task": (
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
        "pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task"
    ),
    "hand_landmarker.task": (
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
        "hand_landmarker/float16/latest/hand_landmarker.task"
    ),
}

KIT_MODELS = Path(__file__).resolve().parent / "models"


def has_models(directory: Path) -> bool:
    return all((directory / name).is_file() for name in MODELS)


def ensure_models(directory: Path | None = None) -> Path:
    target = Path(directory) if directory is not None else KIT_MODELS
    if has_models(target):
        return target
    target.mkdir(parents=True, exist_ok=True)
    for name, url in MODELS.items():
        dest = target / name
        if dest.is_file():
            continue
        print(f"Downloading {name}…")
        urllib.request.urlretrieve(url, dest)
    if not has_models(target):
        raise FileNotFoundError(f"Could not download MediaPipe models into {target}")
    return target


if __name__ == "__main__":
    print(ensure_models())
