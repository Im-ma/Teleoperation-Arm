# Code guide: how Marionette works and where it came from

Read this before touching the code. It tells you which files matter, in what order to read them, and which parts we wrote versus took from open-source projects.

## The big picture

```
camera → web/app.js (MediaPipe finds your joints) → 6 angles → WebSocket → bridge.py → LeRobot → SO-101 follower
```

A physical leader arm just reads 6 motor angles and sends them to the follower. We do the same thing, except the 6 angles come from your body on camera.

## Read in this order

### 1. [`marionette/web/app.js`](../marionette/web/app.js): camera to 6 angles

| Function | What it does |
|---|---|
| `initVision` | loads MediaPipe's pose and hand trackers |
| `frame` | the loop, runs once per camera frame |
| `features` | reads raw angles off the tracked body points |
| `smooth` | removes jitter: big moves pass fast, small shakes get damped |
| `toRobot` | turns your angles into robot degrees |
| `connectWS` | sends the angles to the bridge |
| `STEPS`, `capture` | the sync wizard |
| `makeTwin` | the 3D robot on screen |

### 2. [`marionette/web/mapping.mjs`](../marionette/web/mapping.mjs): matching your joints to the robot's

This is the angle-for-angle design from the [drawings](RESEARCH.md#angle-for-angle-design).

- `armAngles` computes shoulder lift, elbow bend and base rotation in 3D. When your arm is straight up, "which way it points" doesn't exist, so the base keeps its last value.
- `mapMatchedPose` takes the shared straight-up pose as zero, then 1° of yours = 1° of the robot's, clipped to its limits.

### 3. [`marionette/bridge.py`](../marionette/bridge.py): the server that moves the arm

| Function | What it does |
|---|---|
| `loop` | runs 30×/s: caps speed, eases in when you engage, stops if targets stop coming |
| `connect`, `home`, `selftest`, `limp` | the buttons on the page |
| `handle` | receives commands from the page |
| `api_cmd` | the same commands as an HTTP API |
| `auth` | requires the key for anyone not on this laptop |

## What came from where

| Part | Source | What we used |
|---|---|---|
| Arm control | [huggingface/lerobot](https://github.com/huggingface/lerobot) | The teleop loop in `scripts/lerobot_teleoperate.py` is just `teleop.get_action()` → `robot.send_action()`. We call the same `send_action` in `robots/so_follower/so_follower.py`. Degrees mode (0° = middle of each joint's calibrated range) and the torque limits come from there too. |
| Arm hardware | [TheRobotStudio/SO-ARM100](https://github.com/TheRobotStudio/SO-ARM100) | The SO-101 design, joint order, STS3215 servos |
| Servo registers | Feetech SCServo SDK (`scservo_sdk`, installed with LeRobot) | Ping and register reads for debugging: voltage (62), load (60), position (56), torque on/off (40) |
| Body tracking | [google-ai-edge/mediapipe](https://github.com/google-ai-edge/mediapipe) `tasks-vision` 0.10.21 | PoseLandmarker (33 points; we use 11/12 shoulders, 13/14 elbows, 15/16 wrists) and HandLandmarker (21 points; 4 thumb tip, 8 index tip, 5 and 17 knuckles for roll) |
| 3D twin | [mrdoob/three.js](https://github.com/mrdoob/three.js) | rendering and orbit controls |
| Web server | [aio-libs/aiohttp](https://github.com/aio-libs/aiohttp) | WebSocket and HTTP routes |

**Ours:** the joint matching, smoothing, sync wizard, safety layer (speed caps, easing in, dead-man stop, limits), self-test and API.

Why things are built this way, and what broke along the way: [RESEARCH.md](RESEARCH.md).
