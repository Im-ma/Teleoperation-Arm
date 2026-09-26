from __future__ import annotations

import time

import cv2
import streamlit as st

from src.hand_tracking import HandTracker
from src.robot_controller import MockRobotController


st.set_page_config(page_title="MIMIC", page_icon="🤖", layout="wide")

st.markdown(
    """
    <style>
        .block-container {padding-top: 1.4rem; padding-bottom: 1rem;}
        .mimic-title {font-size: 2.4rem; font-weight: 800; letter-spacing: .18em; margin-bottom: 0;}
        .mimic-sub {opacity: .7; margin-top: -.25rem; margin-bottom: 1.5rem;}
        .status-ok {padding: .65rem .9rem; border: 1px solid rgba(80,220,170,.35); border-radius: .8rem; background: rgba(80,220,170,.08);}
        .status-warn {padding: .65rem .9rem; border: 1px solid rgba(255,180,70,.35); border-radius: .8rem; background: rgba(255,180,70,.08);}
    </style>
    """,
    unsafe_allow_html=True,
)

if "running" not in st.session_state:
    st.session_state.running = False
if "robot" not in st.session_state:
    st.session_state.robot = MockRobotController()

robot = st.session_state.robot

st.markdown('<div class="mimic-title">MIMIC</div>', unsafe_allow_html=True)
st.markdown('<div class="mimic-sub">Gesture-Controlled Robotic Arm · Operator Console</div>', unsafe_allow_html=True)

left, right = st.columns([1.7, 1.0], gap="large")

with left:
    st.subheader("Live Camera Feed")
    camera_box = st.empty()

with right:
    st.subheader("System Status")
    robot_status = st.empty()
    hand_status = st.empty()
    mode_status = st.empty()
    gesture_status = st.empty()

    st.divider()
    st.subheader("Arm Position")
    m1, m2 = st.columns(2)
    base_metric = m1.empty()
    shoulder_metric = m2.empty()
    gripper_metric = st.empty()

st.divider()
c1, c2 = st.columns(2)
start = c1.button("▶ Start Control", use_container_width=True, type="primary")
stop = c2.button("■ Pause / Stop", use_container_width=True)

if start:
    robot.start()
    st.session_state.running = True

if stop:
    robot.stop()
    st.session_state.running = False

robot_status.markdown('<div class="status-ok">● Robot &nbsp; <b>Connected</b> &nbsp; <small>(mock mode)</small></div>', unsafe_allow_html=True)
mode_status.markdown(
    '<div class="status-ok">● Control Mode &nbsp; <b>ACTIVE</b></div>' if st.session_state.running
    else '<div class="status-warn">● Control Mode &nbsp; <b>PAUSED</b></div>',
    unsafe_allow_html=True,
)

base_metric.metric("Base", f"{robot.state.base_deg:.0f}°")
shoulder_metric.metric("Shoulder", f"{robot.state.shoulder_deg:.0f}°")
gripper_metric.metric("Gripper", "CLOSED" if robot.state.gripper_closed else "OPEN")

if st.session_state.running:
    tracker = HandTracker()
    cap = cv2.VideoCapture(0)

    if not cap.isOpened():
        st.error("Could not open camera. Check camera permission and device index.")
        st.session_state.running = False
    else:
        try:
            while st.session_state.running:
                ok, frame = cap.read()
                if not ok:
                    st.error("Camera frame could not be read.")
                    break

                frame = cv2.flip(frame, 1)
                annotated, hand = tracker.process(frame)

                if hand.detected:
                    state = robot.update_from_hand(hand.x, hand.y, hand.pinching)
                    hand_status.markdown('<div class="status-ok">● Hand &nbsp; <b>Detected</b></div>', unsafe_allow_html=True)
                    gesture_status.markdown(
                        f'<div class="status-ok">● Gesture &nbsp; <b>{"GRAB" if hand.pinching else "OPEN"}</b></div>',
                        unsafe_allow_html=True,
                    )
                    base_metric.metric("Base", f"{state.base_deg:.0f}°")
                    shoulder_metric.metric("Shoulder", f"{state.shoulder_deg:.0f}°")
                    gripper_metric.metric("Gripper", "CLOSED" if state.gripper_closed else "OPEN")
                else:
                    hand_status.markdown('<div class="status-warn">● Hand &nbsp; <b>Not detected</b></div>', unsafe_allow_html=True)
                    gesture_status.markdown('<div class="status-warn">● Gesture &nbsp; <b>—</b></div>', unsafe_allow_html=True)

                camera_box.image(
                    cv2.cvtColor(annotated, cv2.COLOR_BGR2RGB),
                    channels="RGB",
                    use_container_width=True,
                )
                time.sleep(0.02)
        finally:
            cap.release()
            tracker.close()
else:
    hand_status.markdown('<div class="status-warn">● Hand &nbsp; <b>Waiting</b></div>', unsafe_allow_html=True)
    gesture_status.markdown('<div class="status-warn">● Gesture &nbsp; <b>—</b></div>', unsafe_allow_html=True)
    st.info("Press **Start Control** to begin webcam tracking.")
