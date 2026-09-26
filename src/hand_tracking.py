from __future__ import annotations

from dataclasses import dataclass

import cv2
import mediapipe as mp
import numpy as np


@dataclass
class HandState:
    detected: bool = False
    x: float = 0.5
    y: float = 0.5
    pinch_distance: float = 1.0
    pinching: bool = False


class HandTracker:
    """MediaPipe Hands wrapper for the MIMIC MVP."""

    def __init__(
        self,
        max_num_hands: int = 1,
        min_detection_confidence: float = 0.65,
        min_tracking_confidence: float = 0.65,
        pinch_threshold: float = 0.055,
    ) -> None:
        self.pinch_threshold = pinch_threshold
        self.mp_hands = mp.solutions.hands
        self.drawer = mp.solutions.drawing_utils
        self.hands = self.mp_hands.Hands(
            static_image_mode=False,
            max_num_hands=max_num_hands,
            min_detection_confidence=min_detection_confidence,
            min_tracking_confidence=min_tracking_confidence,
        )

    def process(self, frame: np.ndarray) -> tuple[np.ndarray, HandState]:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        result = self.hands.process(rgb)
        annotated = frame.copy()

        if not result.multi_hand_landmarks:
            return annotated, HandState()

        hand = result.multi_hand_landmarks[0]
        lm = hand.landmark

        wrist = lm[self.mp_hands.HandLandmark.WRIST]
        index_mcp = lm[self.mp_hands.HandLandmark.INDEX_FINGER_MCP]
        pinky_mcp = lm[self.mp_hands.HandLandmark.PINKY_MCP]
        thumb_tip = lm[self.mp_hands.HandLandmark.THUMB_TIP]
        index_tip = lm[self.mp_hands.HandLandmark.INDEX_FINGER_TIP]

        palm_x = (wrist.x + index_mcp.x + pinky_mcp.x) / 3.0
        palm_y = (wrist.y + index_mcp.y + pinky_mcp.y) / 3.0
        pinch_distance = float(
            np.hypot(thumb_tip.x - index_tip.x, thumb_tip.y - index_tip.y)
        )

        state = HandState(
            detected=True,
            x=float(np.clip(palm_x, 0.0, 1.0)),
            y=float(np.clip(palm_y, 0.0, 1.0)),
            pinch_distance=pinch_distance,
            pinching=pinch_distance < self.pinch_threshold,
        )

        self.drawer.draw_landmarks(
            annotated,
            hand,
            self.mp_hands.HAND_CONNECTIONS,
        )
        return annotated, state

    def close(self) -> None:
        self.hands.close()
