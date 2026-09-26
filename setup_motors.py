"""One-time motor ID setup. Connect ONE motor at a time when prompted.

  python setup_motors.py --port COM3
"""

from __future__ import annotations

import argparse

import _bootstrap  # noqa: F401

from so101_teleop.robots.config_so_follower import SO101FollowerConfig
from so101_teleop.robots.so_follower import SO101Follower


def main() -> None:
    parser = argparse.ArgumentParser(description="Set Feetech motor IDs on the SO-101 arm.")
    parser.add_argument("--port", required=True, help="Serial port, e.g. COM3 or /dev/ttyACM0")
    args = parser.parse_args()

    arm = SO101Follower(SO101FollowerConfig(port=args.port, id="setup"))
    arm.setup_motors()


if __name__ == "__main__":
    main()
