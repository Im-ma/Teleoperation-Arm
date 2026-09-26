"""One-time motor ID setup. Connect ONE motor at a time when prompted.

  python setup_motors.py --device follower --port COM4
  python setup_motors.py --device leader --port COM3
"""

from __future__ import annotations

import argparse

import _bootstrap  # noqa: F401

from so101_teleop.robots.config_so_follower import SO101FollowerConfig
from so101_teleop.robots.so_follower import SO101Follower
from so101_teleop.teleoperators.config_so_leader import SO101LeaderConfig
from so101_teleop.teleoperators.so_leader import SO101Leader


def main() -> None:
    parser = argparse.ArgumentParser(description="Set Feetech motor IDs on an SO-101 arm.")
    parser.add_argument("--device", choices=["leader", "follower"], required=True)
    parser.add_argument("--port", required=True, help="Serial port, e.g. COM3 or /dev/ttyACM0")
    args = parser.parse_args()

    if args.device == "leader":
        device = SO101Leader(SO101LeaderConfig(port=args.port, id="setup"))
    else:
        device = SO101Follower(SO101FollowerConfig(port=args.port, id="setup"))

    device.setup_motors()


if __name__ == "__main__":
    main()
