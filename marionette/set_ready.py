"""Teach the ready pose by hand: motors go limp, you pose the arm, Enter saves it and locks the arm there."""
import json
from pathlib import Path

from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig

port = sorted(Path("/dev").glob("tty.usbmodem*"))[0]
r = SO101Follower(SO101FollowerConfig(port=str(port), id="follower", disable_torque_on_disconnect=False))
r.connect()
input("\nHOLD THE ARM, then press Enter to go limp… ")
r.bus.disable_torque()
input("Limp. Untangle the wrist cable, pose the arm STRAIGHT UP, gripper centred and closed, then press Enter… ")
obs = r.get_observation()
pose = {k.removesuffix(".pos"): round(float(v), 1) for k, v in obs.items() if k.endswith(".pos")}
r.send_action(obs)          # hold exactly here
r.bus.enable_torque()
(Path(__file__).parent / "poses.json").write_text(json.dumps({"ready": pose}, indent=2))
print("Saved ready pose:", pose)
r.disconnect()
