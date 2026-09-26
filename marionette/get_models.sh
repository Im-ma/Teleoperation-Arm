#!/bin/sh
# MediaPipe models used by the web app and mimic.py (about 17 MB)
cd "$(dirname "$0")" && mkdir -p models
curl -fL -o models/pose_landmarker_full.task https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
curl -fL -o models/hand_landmarker.task https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task
