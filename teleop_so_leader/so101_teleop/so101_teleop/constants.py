import os
from pathlib import Path

ROBOTS = "robots"

# Calibration lives inside this kit so the folder is portable.
# Override with SO101_CALIBRATION if you want it somewhere else.
KIT_ROOT = Path(__file__).resolve().parent.parent
CALIBRATION_DIR = Path(os.getenv("SO101_CALIBRATION", KIT_ROOT / "calibration")).expanduser()
