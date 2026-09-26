"""Calibrate the SO-101 arm and save offsets into ./calibration/.

  python calibrate.py --port COM3 --id my_arm
"""

from __future__ import annotations

import argparse

import _bootstrap  # noqa: F401

from so101_teleop.robots.config_so_follower import SO101FollowerConfig
from so101_teleop.robots.so_follower import SO101Follower
from so101_teleop.utils import init_logging


def main() -> None:
    parser = argparse.ArgumentParser(description="Calibrate the SO-101 arm.")
    parser.add_argument("--port", required=True)
    parser.add_argument("--id", default="my_arm", help="Calibration key. Reuse the same id for teleop.")
    args = parser.parse_args()
    init_logging()

    arm = SO101Follower(SO101FollowerConfig(port=args.port, id=args.id))
    arm.connect(calibrate=False)
    try:
        arm.calibrate()
    finally:
        arm.disconnect()


if __name__ == "__main__":
    main()
