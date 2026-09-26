# SO-101 standalone teleop

This folder is the whole kit. Copy `so101_teleop` anywhere. You do **not** need the rest of LeRobot.

It only does this: you move the **leader** arm, the **follower** arm copies the same 6 joints.

---

## What you need

### Hardware

- SO-101 **leader** arm (handle) and **follower** arm
- The **correct power supply for your build**. SO-101 ships as either **5 V / 7.4 V** or **12 V**. They are not interchangeable. Using the wrong voltage puts motors in an error state (blinking LEDs).
- USB cable for each arm (two COM ports)
- Both arms assembled, clamped, and powered

Before any software step, look at the **red motor LEDs** on the daisy chain (gripper → base):

| LEDs | Meaning |
|---|---|
| All steady red | Wiring OK |
| One or more dark / chain stops mid-arm | Reseat the 3-pin cables, check the board PSU |
| Blinking | Motor error: overload, joint forced past a limit, or wrong voltage |

### Computer

- **Python 3.12 or newer** (`python --version`)
- Windows, Linux, or macOS
- On Windows, if COM ports never appear: install the USB-serial driver for the controller board (often CH340, CP2102, or FTDI)

---

## 1. Install software

Open a terminal **in this folder**.

**Windows (easiest):** double-click `install.bat`, or:

```bat
python -m venv .venv
.venv\Scripts\activate
python -m pip install -r requirements.txt
```

**Linux / macOS:**

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

That installs only:

- `pyserial` — USB serial
- `feetech-servo-sdk` — STS3215 motors
- `deepdiff` — calibration compare

Keep the venv activated for every command below.

Linux extra: your user must be allowed to open serial ports.

```bash
sudo usermod -aG dialout $USER
# log out and back in
# if a port is still locked: sudo chmod 666 /dev/ttyACM0
```

---

## 2. Find USB ports

Do this **once per arm**. Leave both arms plugged in first, then unplug **only the arm you are identifying**.

```bat
python find_port.py
```

Write the two ports down. Examples:

- Windows: `COM3` (leader), `COM4` (follower)
- Linux: `/dev/ttyACM0`, `/dev/ttyACM1`
- macOS: `/dev/tty.usbmodem...`

If you mix them up, teleop will feel inverted or fail to open a port. Run `find_port.py` again.

---

## 3. Motor IDs (first time only)

Skip this if the arms already worked with LeRobot or another SO-101 setup.

Power the arm. When prompted, connect the controller board to **one motor only**, then press Enter. Repeat until all 6 IDs are set (gripper → wrist → … → base).

```bat
python setup_motors.py --device follower --port COM4
python setup_motors.py --device leader --port COM3
```

Replace `COM3` / `COM4` with your ports.

---

## 4. Calibrate both arms

Do leader and follower separately. Use IDs you will reuse in teleop (`my_leader`, `my_follower` below).

```bat
python calibrate.py --device follower --port COM4 --id my_follower
python calibrate.py --device leader --port COM3 --id my_leader
```

When asked:

1. Move the arm to the **middle of its range** (the diagram printed in the terminal). Press Enter.
2. Move every joint **except wrist roll** through its full range. Press Enter when done.

Files are written **inside this folder**:

```
calibration/robots/so_follower/my_follower.json
calibration/teleoperators/so_leader/my_leader.json
```

Copy this folder to another PC and those files go with it.

Already calibrated with full LeRobot? Copy the matching JSON files into the paths above, or set:

```bat
set SO101_CALIBRATION=%USERPROFILE%\.cache\huggingface\lerobot\calibration
```

---

## 5. Teleoperate

Power **both** arms. Activate the venv. Then:

```bat
python teleoperate.py --leader-port COM3 --follower-port COM4 --leader-id my_leader --follower-id my_follower
```

Move the leader. The follower should track. **Ctrl+C** stops and disconnects.

Optional: `--fps 30` (default), `--duration 60` to auto-stop after 60 seconds.

---

## If something fails

| Symptom | What to check |
|---|---|
| `Could not connect on port` | Wrong COM port, cable unplugged, another program using the port. Run `python find_port.py`. |
| `feetech-servo-sdk` / `pyserial` import error | Venv not active, or `pip install -r requirements.txt` was skipped. |
| Timeout / comms error while moving | Red LEDs first. Wiring or voltage, not the script. |
| Follower does not match leader | Recalibrate both arms with the same `--id` values you pass to `teleoperate.py`. Confirm ports are not swapped. |
| Python version error | Need 3.12+. |

---

## What this kit does not do

No cameras, no dataset recording, no training, no Hugging Face upload. For those, use the full LeRobot repo (`lerobot-record`, `lerobot-train`).
