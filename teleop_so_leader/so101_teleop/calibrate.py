"""Calibrate one SO-101 arm and save offsets into ./calibration/.

  python calibrate.py --device follower --port COM4 --id my_follower
  python calibrate.py --device leader --port COM3 --id my_leader
"""

from __future__ import annotations

import argparse

import _bootstrap  # noqa: F401

from so101_teleop.robots.config_so_follower import SO101FollowerConfig
from so101_teleop.robots.so_follower import SO101Follower
from so101_teleop.teleoperators.config_so_leader import SO101LeaderConfig
from so101_teleop.teleoperators.so_leader import SO101Leader
from so101_teleop.utils import init_logging


def main() -> None:
    parser = argparse.ArgumentParser(description="Calibrate an SO-101 leader or follower.")
    parser.add_argument("--device", choices=["leader", "follower"], required=True)
    parser.add_argument("--port", required=True)
    parser.add_argument("--id", required=True, help="Calibration key. Reuse the same id later for teleop.")
    args = parser.parse_args()
    init_logging()

    if args.device == "leader":
        device = SO101Leader(SO101LeaderConfig(port=args.port, id=args.id))
    else:
        device = SO101Follower(SO101FollowerConfig(port=args.port, id=args.id))

    device.connect(calibrate=False)
    try:
        device.calibrate()
    finally:
        device.disconnect()


if __name__ == "__main__":
    main()
