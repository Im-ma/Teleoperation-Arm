"""Gemini Live: watches the camera stream and describes each arm movement in robot joints.

The browser streams cropped frames (about 1 per second) to /ws/vision; when the arm stops it sends "ask".
The model answers by calling robot_move, which is relayed back to the browser. The key stays here.
"""
from __future__ import annotations

import asyncio
import json
import os
import time

import aiohttp
from aiohttp import web

URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
TOOL = {"functionDeclarations": [{
    "name": "robot_move",
    "description": "Report the arm movement just seen, as SO-101 robot joint moves, biggest first.",
    "parameters": {"type": "OBJECT", "required": ["summary", "pose", "moves"], "properties": {
        "pose": {"type": "OBJECT", "description": "The person's arm at the END, in degrees above level (0 = level, 90 = straight up, -90 = straight down).",
                 "required": ["upper_arm", "forearm", "hand", "turn", "thumb"], "properties": {
            "upper_arm": {"type": "NUMBER"}, "forearm": {"type": "NUMBER"}, "hand": {"type": "NUMBER", "description": "Wrist to fingertips."},
            "turn": {"type": "NUMBER", "description": "How far the whole arm has swung sideways since REFERENCE, degrees: "
                     "positive = across toward the person's own left (in front of the body), negative = out to their right, 0 = as in REFERENCE."},
            "thumb": {"type": "NUMBER", "description": "The claw: how far the thumb is spread from the index finger, "
                      "0 = thumb touching the fingers (claw shut), 100 = thumb spread wide (claw fully open). Always give it."}}},
        "summary": {"type": "STRING", "description": "One short sentence: what the person's arm did."},
        "moves": {"type": "ARRAY", "items": {"type": "OBJECT", "required": ["joint", "body_part", "direction", "degrees"], "properties": {
            "joint": {"type": "STRING", "enum": JOINTS},
            "body_part": {"type": "STRING", "enum": ["upper arm", "forearm", "hand", "wrist", "fingers"]},
            "direction": {"type": "STRING", "enum": ["up", "down", "forward", "back", "twist in", "twist out", "open", "close", "match"]},
            "degrees": {"type": "NUMBER", "description": "How far it moved, 0-180 (gripper: 0-100 %)."},
            "robot_to": {"type": "NUMBER", "description": "The robot joint value that now matches the person, starting from the robot's current value you were given."}}}}}}}]}
SYSTEM = (
    "You watch a live camera of one person controlling a 6-motor SO-101 robot arm with their right arm. Frames are the "
    "camera's plain view (not mirrored, so their right arm is on the image's left); judge the person, not any robot in view. The robot copies the arm: "
    "motor 1 shoulder_pan = the person turning their shoulders/body (or swinging the whole arm) toward the camera's left or right; motor 2 shoulder_lift = upper arm up/down; "
    "motor 3 elbow_flex = forearm up/down (bending at the elbow); motor 4 wrist_flex = hand tilting up/down at the wrist; "
    "motor 5 wrist_roll = forearm twist; motor 6 gripper is locked to the THUMB: thumb moving away from the other "
    "fingers = open, thumb closing onto them = close. The robot's angles relate to the body: "
    "upper arm above level = 76 - shoulder_lift; forearm above level = upper arm - (elbow_flex + 74); hand above level = "
    "forearm - 5 - wrist_flex; gripper 0 = closed, higher = more open. You drive the robot: make its side-view shape "
    "match the person's arm (upper arm, forearm and hand at the same angles above level), claw open as wide as the thumb "
    "is from the fingers, pan and twist moved by the same degrees as the person's. Stay inside the joint limits; when a "
    "pose is out of reach, get as close as you can. "
    "When asked, call robot_move once for the movement since you were last asked: only joints that really moved, "
    "biggest first, and for each give robot_to: the value that joint needs so the robot matches the person's arm now, "
    "starting from the robot's current values you are given. Also add any joint where the robot does not match the "
    "person even though it did not move, with direction match, degrees 0 and its robot_to. If nothing moved, call it with an empty moves list. Never speak."
)


def robot_text(r: dict | None, lim: dict | None = None) -> str:
    """The robot's current joints, plus what they mean for the arm, so the model can match robot to person."""
    if not r or not all(isinstance(r.get(j), (int, float)) for j in JOINTS[:4]):
        return ""
    up = 76 - r["shoulder_lift"]
    fore = up - (r["elbow_flex"] + 74)
    joints = ", ".join(f"{j} {r[j]:.0f}" for j in JOINTS if isinstance(r.get(j), (int, float)))
    return (f"The robot is now at {joints} (its upper arm {up:.0f} deg above level, forearm {fore:.0f}, "
            f"hand {fore - 5 - r['wrist_flex']:.0f}). " +
            ("Joint limits: " + ", ".join(f"{j} {v[0]:.0f}..{v[1]:.0f}" for j, v in lim.items() if j in JOINTS and len(v) == 2) + ". " if lim else ""))


async def ws_vision(req):
    """One Gemini Live session per browser connection, opened on connect, reopened if Google closes it."""
    browser = web.WebSocketResponse(heartbeat=20)
    await browser.prepare(req)
    key, model = os.environ.get("GEMINI_API_KEY"), os.environ.get("LIVE_MODEL", "gemini-3.8-live")
    if not key:
        await browser.send_json({"error": "No GEMINI_API_KEY in .env"})
        return browser
    asked = [0.0]   # when the last question went out; 0 once it has been answered
    async with aiohttp.ClientSession() as s:
        while not browser.closed:
            try:
                async with s.ws_connect(URL, headers={"x-goog-api-key": key}, heartbeat=20) as g:
                    # gemini-3.8-live answers in audio only and takes no thinking level: we only use its tool calls
                    live38 = "3.8-live" in model and "extended" not in model
                    gen = {"responseModalities": [os.environ.get("LIVE_MODALITY", "AUDIO" if live38 else "TEXT")], "mediaResolution": "MEDIA_RESOLUTION_LOW"}
                    if not live38:
                        gen["thinkingConfig"] = {"thinkingLevel": os.environ.get("LIVE_THINKING", "minimal")}
                    await g.send_json({"setup": {
                        "model": f"models/{model}", "generationConfig": gen,
                        "systemInstruction": {"parts": [{"text": SYSTEM}]}, "tools": [TOOL],
                        "contextWindowCompression": {"slidingWindow": {}}}})
                    await browser.send_json({"status": f"connecting to {model}"})

                    async def from_browser():
                        async for m in browser:
                            if m.type != aiohttp.WSMsgType.TEXT:
                                break
                            d = json.loads(m.data)
                            if d.get("frame"):
                                await g.send_json({"realtimeInput": {"video": {"data": d["frame"], "mimeType": "image/jpeg"}}})
                            if d.get("calibrate"):   # context only, no answer: this frame is the robot's ready pose
                                await g.send_json({"clientContent": {"turns": [{"role": "user", "parts": [
                                    {"text": "CALIBRATION: the person copies the robot's rest pose with the right arm. "
                                             "This pose IS the robot's rest pose: " +
                                             robot_text(d.get("robot"), d.get("limits")) +
                                             " Use it as the zero for every later reading."},
                                    {"inlineData": {"mimeType": "image/jpeg", "data": d["calibrate"]}}]}], "turnComplete": False}})
                            if d.get("ask"):
                                asked[0] = time.time()
                                # the movement's first and last frames side by side with the question: the stream alone
                                # is one frame a second and the model tends to look only at the latest one
                                img = lambda b: {"inlineData": {"mimeType": "image/jpeg", "data": b}}
                                if d.get("now"):   # continuous: read the person now against the calibration frame
                                    parts = [*([{"text": "REFERENCE (calibration: this pose is the robot's rest pose):"}, img(d["ref"])] if d.get("ref") else []),
                                             {"text": "NOW:"}, img(d["now"]),
                                             {"text": "Read the person's right arm NOW and call robot_move right away with pose "
                                                      "(upper_arm, forearm, hand, turn against REFERENCE, thumb). moves may be empty. "
                                                      + robot_text(d.get("robot"), d.get("limits"))}]
                                    await g.send_json({"clientContent": {"turns": [{"role": "user", "parts": parts}], "turnComplete": True}})
                                    continue
                                parts = [*([{"text": "START of the movement:"}, img(d["start"])] if d.get("start") else []),
                                         *([{"text": "END of the movement:"}, img(d["end"])] if d.get("end") else []),
                                         {"text": "The arm just stopped. " + robot_text(d.get("robot"), d.get("limits")) +
                                          ("Compare START with END and report the movement with robot_move." if d.get("start") else
                                          "This is the person now. Call robot_move with direction match for every joint "
                                          "so the robot takes the person's pose.")}]
                                await g.send_json({"clientContent": {"turns": [{"role": "user", "parts": parts}], "turnComplete": True}})
                        await g.close()

                    pump = asyncio.create_task(from_browser())
                    try:
                        while True:
                            m = await g.receive()
                            if m.type not in (aiohttp.WSMsgType.TEXT, aiohttp.WSMsgType.BINARY):   # Google closed: say why
                                if not browser.closed and m.extra:
                                    await browser.send_json({"error": f"Gemini Live closed: {str(m.extra)[:200]}"})
                                    await asyncio.sleep(2)
                                break
                            d = json.loads(m.data if m.type == aiohttp.WSMsgType.TEXT else m.data.decode())
                            if "setupComplete" in d:
                                await browser.send_json({"status": f"live · {model}"})
                            for c in d.get("toolCall", {}).get("functionCalls", []):
                                if asked[0]:   # one answer per question: the model sometimes keeps reporting
                                    await browser.send_json({"move": c.get("args", {}), "ms": round((time.time() - asked[0]) * 1000)})
                                    asked[0] = 0.0
                                await g.send_json({"toolResponse": {"functionResponses": [
                                    {"id": c.get("id"), "name": c.get("name"), "response": {"result": "noted. Wait silently for the next question."}}]}})
                            if "goAway" in d:
                                break
                    finally:
                        pump.cancel()
            except Exception as e:
                if not browser.closed:
                    await browser.send_json({"error": f"Gemini Live: {str(e)[:120]}"})
                    await asyncio.sleep(2)
    return browser
