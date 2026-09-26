"""Camera teleop for the one SO-101 arm. Your arm is the controller.

  python teleoperate.py
  python teleoperate.py --port COM3 --id my_arm
"""

from __future__ import annotations

import argparse

import _bootstrap  # noqa: F401

from so101_teleop.utils import init_logging


def main() -> None:
    parser = argparse.ArgumentParser(description="Drive the SO-101 from a webcam in the browser.")
    parser.add_argument("--port", "--follower-port", dest="port", help="Arm COM/tty port, e.g. COM3")
    parser.add_argument("--id", "--follower-id", dest="robot_id", default="my_arm")
    parser.add_argument("--dry-run", action="store_true", help="Website only; do not open the arm.")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--http-port", type=int, default=8000)
    args = parser.parse_args()
    init_logging()

    from serve import run

    run(
        follower_port=args.port,
        follower_id=args.robot_id,
        http_port=args.http_port,
        open_browser=not args.no_browser,
        connect_robot=not args.dry_run,
    )


if __name__ == "__main__":
    main()
