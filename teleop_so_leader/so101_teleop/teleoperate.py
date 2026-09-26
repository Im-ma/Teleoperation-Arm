"""SO-101 leader -> follower teleoperation.

  python teleoperate.py --leader-port COM3 --follower-port COM4 --leader-id my_leader --follower-id my_follower
"""

from __future__ import annotations

import argparse
import time

import _bootstrap  # noqa: F401

from so101_teleop.robots.config_so_follower import SO101FollowerConfig
from so101_teleop.robots.so_follower import SO101Follower
from so101_teleop.teleoperators.config_so_leader import SO101LeaderConfig
from so101_teleop.teleoperators.so_leader import SO101Leader
from so101_teleop.utils import init_logging, move_cursor_up


def teleop_loop(leader: SO101Leader, follower: SO101Follower, fps: int, duration: float | None) -> None:
    display_len = max(len(key) for key in follower.action_features)
    period = 1.0 / fps
    start = time.perf_counter()
    while True:
        loop_start = time.perf_counter()
        action = leader.get_action()
        sent = follower.send_action(action)

        print("\n" + "-" * (display_len + 10))
        print(f"{'NAME':<{display_len}} | {'NORM':>7}")
        for motor, value in sent.items():
            print(f"{motor:<{display_len}} | {value:>7.2f}")
        loop_s = time.perf_counter() - loop_start
        print(f"Teleop loop time: {loop_s * 1e3:.2f}ms ({1 / max(loop_s, 1e-6):.0f} Hz)")
        move_cursor_up(len(sent) + 4)

        remaining = period - (time.perf_counter() - loop_start)
        if remaining > 0:
            time.sleep(remaining)

        if duration is not None and time.perf_counter() - start >= duration:
            return


def main() -> None:
    parser = argparse.ArgumentParser(description="Teleoperate an SO-101 follower from the leader arm.")
    parser.add_argument("--leader-port", required=True)
    parser.add_argument("--follower-port", required=True)
    parser.add_argument("--leader-id", default="my_leader")
    parser.add_argument("--follower-id", default="my_follower")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--duration", type=float, default=None, help="Stop after this many seconds.")
    args = parser.parse_args()
    init_logging()

    leader = SO101Leader(SO101LeaderConfig(port=args.leader_port, id=args.leader_id))
    follower = SO101Follower(SO101FollowerConfig(port=args.follower_port, id=args.follower_id))

    leader.connect()
    follower.connect()
    try:
        print("Teleop running. Move the leader. Ctrl+C to stop.")
        teleop_loop(leader, follower, fps=args.fps, duration=args.duration)
    except KeyboardInterrupt:
        print("\nStopping teleop.")
    finally:
        leader.disconnect()
        follower.disconnect()


if __name__ == "__main__":
    main()
