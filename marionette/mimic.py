"""Camera teleop for the SO-101 follower: the webcam watches your arm and the robot copies it.

  python mimic.py --dry-run      # camera + tracking only, robot untouched
  python mimic.py                # drive the follower

Keys: SPACE engage/disengage (copy starts from wherever the robot is), Q quit.
Match the robot's pose with your arm before pressing SPACE so nothing jumps.
"""
import argparse, json, time
from pathlib import Path

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions, vision

HERE = Path(__file__).parent
CALIB = Path.home() / ".cache/huggingface/lerobot/calibration/robots/so_follower/follower.json"
JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll"]
# Flip a sign if that joint moves the wrong way; gain scales how far the robot moves per degree of yours.
SIGN = {"shoulder_pan": 1, "shoulder_lift": -1, "elbow_flex": 1, "wrist_flex": 1, "wrist_roll": 1}
GAIN = {"shoulder_pan": 1.0, "shoulder_lift": 1.0, "elbow_flex": 1.0, "wrist_flex": 0.8, "wrist_roll": 0.0}
GRIP_INVERT = False     # set True if pinching opens the gripper instead of closing it
SMOOTH = 0.35           # 0..1, higher = snappier, lower = steadier
MAX_STEP = 6.0          # max degrees per frame per joint
POSE = {"right": (12, 14, 16, 20), "left": (11, 13, 15, 19)}  # shoulder, elbow, wrist, index


def angle(a, b):
    c = np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9)
    return float(np.degrees(np.arccos(np.clip(c, -1, 1))))


def human_angles(pose, arm):
    """Your arm as joint angles in degrees, plus the image points to draw."""
    s, e, w, i = POSE[arm]
    W = np.array([[p.x, p.y, p.z] for p in pose.pose_world_landmarks[0]])
    L = pose.pose_landmarks[0]
    upper, fore, hand = W[e] - W[s], W[w] - W[e], W[i] - W[w]
    lift = angle(upper, [0, 1, 0])                   # 0 hanging down, 90 straight out, 180 up
    elbow = angle(upper, fore)                       # 0 straight, 90 bent
    bend = angle(fore, hand)
    n = np.cross(upper, fore)
    wrist = bend * (np.sign(np.dot(np.cross(fore, hand), n)) or 1)
    width = abs(L[11].x - L[12].x) + 1e-6
    pan = float(np.clip((L[w].x - L[s].x) / width, -2, 2)) * 45   # side-to-side reach
    vis = min(L[k].visibility for k in (s, e, w))
    pts = [(L[k].x, L[k].y) for k in (s, e, w, i)]
    return {"shoulder_pan": pan, "shoulder_lift": lift, "elbow_flex": elbow, "wrist_flex": wrist}, vis, pts


def hand_state(hands, arm):
    """Gripper 0..100 from thumb-index pinch, and wrist roll from knuckle line."""
    for lm, side in zip(hands.hand_landmarks, hands.handedness):
        # MediaPipe assumes a mirrored selfie image; on the raw frame your right hand is labeled "Left"
        if side[0].category_name.lower() == arm:
            continue
        P = np.array([[p.x, p.y] for p in lm])
        size = np.linalg.norm(P[9] - P[0]) + 1e-6
        pinch = np.linalg.norm(P[4] - P[8]) / size
        grip = float(np.clip((pinch - 0.15) / 0.9, 0, 1)) * 100
        k = P[17] - P[5]
        roll = float(np.degrees(np.arctan2(k[1], k[0])))
        return grip, roll, P
    return None, None, None


def limits():
    c = json.loads(CALIB.read_text())
    out = {}
    for j, v in c.items():
        mid = (v["range_min"] + v["range_max"]) / 2
        out[j] = ((v["range_min"] - mid) * 360 / 4095 + 3, (v["range_max"] - mid) * 360 / 4095 - 3)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/tty.usbmodem5B7B0179591")
    ap.add_argument("--arm", choices=["right", "left"], default="right")
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    robot = None
    if not a.dry_run:
        from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig
        robot = SO101Follower(SO101FollowerConfig(port=a.port, id="follower", max_relative_target=15.0,
                                                  disable_torque_on_disconnect=False))
        robot.connect()
        lim = limits()

    mk = lambda cls, opt, f, **kw: cls.create_from_options(opt(base_options=BaseOptions(model_asset_path=str(HERE / "models" / f)),
                                                            running_mode=vision.RunningMode.VIDEO, **kw))
    pose_lm = mk(vision.PoseLandmarker, vision.PoseLandmarkerOptions, "pose_landmarker_full.task")
    hand_lm = mk(vision.HandLandmarker, vision.HandLandmarkerOptions, "hand_landmarker.task", num_hands=2)

    cam = cv2.VideoCapture(a.camera)
    if not cam.isOpened():
        raise SystemExit("Can't open the camera. Allow camera access for this terminal in System Settings > Privacy.")

    engaged, h0, q0, target, smooth = False, None, None, {}, None
    grip0, roll0, errors, t0 = None, None, 0, time.monotonic()
    while True:
        ok, frame = cam.read()
        if not ok:
            break
        ts = int((time.monotonic() - t0) * 1000)
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        pose, hands = pose_lm.detect_for_video(img, ts), hand_lm.detect_for_video(img, ts)
        h, vis, pts = (human_angles(pose, a.arm) if pose.pose_world_landmarks else (None, 0, None))
        grip, roll, hp = hand_state(hands, a.arm)
        H, Wd = frame.shape[:2]
        if h is not None and vis > 0.5:
            h["wrist_roll"] = roll if roll is not None else (smooth or {}).get("wrist_roll", 0)
            smooth = h if smooth is None else {k: smooth[k] + SMOOTH * (h[k] - smooth[k]) for k in h}
            for p, q in zip(pts, pts[1:]):
                cv2.line(frame, (int(p[0] * Wd), int(p[1] * H)), (int(q[0] * Wd), int(q[1] * H)), (60, 190, 255), 6)
        if hp is not None:
            for x, y in hp:
                cv2.circle(frame, (int(x * Wd), int(y * H)), 3, (255, 255, 255), -1)

        if robot and engaged and smooth:
            for j in JOINTS:
                d = SIGN[j] * GAIN[j] * (smooth[j] - h0[j])
                if j == "wrist_roll":
                    d = SIGN[j] * GAIN[j] * ((smooth[j] - h0[j] + 180) % 360 - 180)
                want = float(np.clip(q0[j] + d, *lim[j]))
                target[j] = target[j] + float(np.clip(want - target[j], -MAX_STEP, MAX_STEP))
            if grip is not None:
                target["gripper"] = (100 - grip) if GRIP_INVERT else grip
            try:
                robot.send_action({f"{k}.pos": v for k, v in target.items()})
            except (ConnectionError, OSError) as ex:
                errors += 1
                if errors % 10 == 1:
                    print("bus hiccup:", ex)

        view = cv2.flip(frame, 1)
        lines = [("ENGAGED - robot copying you" if engaged else "SPACE to engage   Q to quit") if robot else "DRY RUN (robot off)"]
        if smooth:
            lines += [f"{j:14s} you {smooth[j]:7.1f}" + (f"   robot {target.get(j, 0):7.1f}" if engaged else "") for j in JOINTS]
        lines.append(f"gripper        {'-' if grip is None else f'{grip:5.0f}'}")
        for n, t in enumerate(lines):
            cv2.putText(view, t, (16, 34 + n * 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 4)
            cv2.putText(view, t, (16, 34 + n * 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (80, 255, 160) if engaged else (255, 255, 255), 2)
        cv2.imshow("SO-101 mimic", view)

        k = cv2.waitKey(1) & 0xFF
        if k in (ord("q"), 27):
            break
        if k == ord(" ") and robot and smooth:
            engaged = not engaged
            if engaged:
                obs = robot.get_observation()
                q0 = {j: obs[f"{j}.pos"] for j in JOINTS}
                target = dict(q0, gripper=obs["gripper.pos"])
                h0 = dict(smooth)
            print("engaged" if engaged else "paused")

    cam.release()
    cv2.destroyAllWindows()
    if robot:
        robot.disconnect()


if __name__ == "__main__":
    main()
