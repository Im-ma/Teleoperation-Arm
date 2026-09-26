# MIMIC

**Gesture-controlled robotic arm teleoperation using computer vision and the SO-ARM101.**

MIMIC explores a simple idea: controlling a remote robotic arm should feel as natural as moving your own hand.

## Hackathon MVP

Camera → hand tracking → gesture interpretation → robot commands → SO-ARM101

The first working milestone is intentionally small:

- Detect one hand from a webcam
- Track palm X/Y position
- Detect pinch/open-hand gestures
- Map hand movement to robot movement
- Use pinch to close the gripper
- Use open hand to release
- Show robot/hand/control state in a lightweight operator interface
- Include a clear pause/stop control

## Project structure

```
MIMIC/
├── app.py
├── requirements.txt
├── src/
│   ├── __init__.py
│   ├── hand_tracking.py
│   └── robot_controller.py
└── .gitignore
```

## Quick start

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
streamlit run app.py
```

Windows activation:

```powershell
.venv\Scripts\activate
```

Mock mode lets the camera + gesture UI work before the physical arm is connected.

## Current control mapping

| Human input | Robot action |
|---|---|
| Move hand left/right | Base rotation |
| Move hand up/down | Shoulder movement |
| Thumb/index pinch | Close gripper |
| Open pinch | Open gripper |

## Safety

The first physical integration should use conservative joint limits and low movement speed. Keep a physical way to remove power from the arm during testing. Do not map raw camera coordinates directly to unrestricted joint commands.

## Hardware

- Seeed Studio SO-ARM101
- Laptop
- Webcam / built-in camera
- SO-ARM101 power and USB connection

No Arduino or ESP32 is required for the current approach.

## Next milestone

1. Confirm camera tracking works.
2. Confirm the SO-ARM101 can be commanded from the laptop.
3. Connect one tracked axis to one robot joint.
4. Add the gripper gesture.
5. Add smoothing, dead zones, and safe limits.
