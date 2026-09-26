# Marionette: full-arm teleop in the browser

Your whole arm is the leader arm. The browser tracks your shoulder, elbow, wrist and fingers with the webcam, and a small Python bridge drives the SO-101 follower through LeRobot — the same `send_action()` call a physical leader arm uses.

**What kind of project is this?** Computer vision first, robotics second: vision-based teleoperation. The camera does markerless motion capture (MediaPipe pose + hand estimation), we turn the tracked joints into angles, then retarget those angles onto the robot's joints. No sensors on your body, no leader arm.

```
browser (camera + MediaPipe + 3D twin) ──WebSocket──▶ bridge.py ──LeRobot──▶ SO-101 follower
```

## Run it

```bash
cd marionette
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
./get_models.sh
python bridge.py          # open http://localhost:8000 in Chrome
```

The follower must be calibrated first (`lerobot-calibrate --robot.type=so101_follower --robot.port=<port> --robot.id=follower`).

## What happens

1. **Plug in the arm** → the bridge connects on its own and glides to the ready pose.
2. **Camera step** → pick a camera and which arm drives; tick off shoulder, elbow, wrist, hand.
3. **Sync** → 9 held poses (arm down/up, elbow bend, sweep left/right, wrist up/down, open/pinch) capture your range of motion. Saved in the browser.
4. **Live** → a 3D twin follows you. Press **Space** to engage the real arm; it eases onto your pose over 1.5 s.

Buttons on the live screen: **Ready pose**, **Test all joints** (moves each joint 12° and checks it arrived), **Pose by hand** (torque off) and **Save as ready**.

## Safety

- Commanded speed is capped at 120°/s while driving and 45°/s for automatic moves.
- Targets are clipped to the calibrated range minus 3°; wrist roll is capped at ±147° (see [research notes](../docs/RESEARCH.md#wrist-roll-wrap)).
- If your arm leaves the frame for 400 ms, targets stop and the robot holds.
- Closing the page disengages.

## HTTP API

Everything the page does is also an HTTP call:

| Call | Does |
|---|---|
| `GET /api/state` | status, mode, limits, ready pose, joint readings |
| `POST /api/connect` | connect to the arm |
| `POST /api/home` | go to the ready pose |
| `POST /api/selftest` | test all 6 joints |
| `POST /api/engage` `{"on": true}` | start/stop following targets |
| `POST /api/target` `{"joints": {"elbow_flex": 20, ...}}` | set the target pose (degrees; gripper 0–100) |
| `POST /api/limp` `{"on": true}` | torque off / back on |
| `POST /api/save_ready` | save the current pose as ready (while limp) |

Requests from localhost need no key. Anything arriving through a tunnel or another machine needs the key in `marionette/.key` (created on first run), as `Authorization: Bearer <key>` or, for the web page, a link ending in `#key=<key>`.

## Other files

- `set_ready.py`: teach the ready pose by hand from the terminal.
- `test_bridge.py`: waits for the ready pose, then runs the self-test through the bridge.
- `mimic.py`: the earlier desktop version (OpenCV window instead of a browser).
