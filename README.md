# Teleoperation Arm

One SO-101 arm, driven from your webcam. MediaPipe in the browser is the controller. There is no leader arm.

```bat
cd teleop_so_leader\so101_teleop
.venv\Scripts\activate
python teleoperate.py --port COM3 --id my_arm
```

That opens http://127.0.0.1:8000, connects the arm on USB, and follows your pose after you match and press Space.

First-time extras, only if needed:

```bat
python find_port.py
python setup_motors.py --port COM3
python calibrate.py --port COM3 --id my_arm
python get_models.py
```
