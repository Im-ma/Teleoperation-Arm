"""Cloud helpers: ElevenLabs voice and Gemini commands. Keys live in .env, never in the browser.

Nothing here can move the robot directly. Gemini only picks a name from GESTURES,
and serve.py plays that gesture at capped speed, and only while nobody is driving.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path

import aiohttp

HERE = Path(__file__).resolve().parent
VOICE_CACHE = HERE / "voice_cache"


def load_env() -> None:
    for path in (HERE / ".env",):
        if path.exists():
            for line in path.read_text().splitlines():
                k, sep, v = line.partition("=")
                if sep and not k.strip().startswith("#"):
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def keys() -> dict[str, bool]:
    return {name: bool(os.environ.get(var)) for name, var in
            (("voice", "ELEVENLABS_API_KEY"), ("gemini", "GEMINI_API_KEY"), ("tiger", "TIGER_DATABASE_URL"))}


# Gesture keyframes, as offsets in degrees from the ready (goalpost) pose.
GESTURES = {
    "wave": [{"wrist_flex": 25}, {"wrist_flex": -20}, {"wrist_flex": 25}, {"wrist_flex": -20}, {}],
    "nod": [{"wrist_flex": 30}, {"wrist_flex": -5}, {"wrist_flex": 30}, {}],
    "bow": [{"shoulder_lift": 35, "wrist_flex": 30}, {"shoulder_lift": 35, "wrist_flex": 30}, {}],
    "dance": [{"shoulder_pan": 25, "wrist_roll": 40}, {"shoulder_pan": -25, "wrist_roll": -40},
              {"shoulder_pan": 25, "wrist_roll": 40}, {"shoulder_pan": -25, "wrist_roll": -40}, {}],
    "point_left": [{"shoulder_pan": 40, "gripper": -60}, {"shoulder_pan": 40, "gripper": -60}, {}],
    "point_right": [{"shoulder_pan": -40, "gripper": -60}, {"shoulder_pan": -40, "gripper": -60}, {}],
    "clap": [{"gripper": -60}, {"gripper": 20}, {"gripper": -60}, {"gripper": 20}, {}],
    "home": [{}],
}
WORDS = {"wave": "wave|hello|hi\\b|hey", "nod": "nod|yes", "bow": "bow|thank", "dance": "dance|party|groove",
         "point_left": "left", "point_right": "right", "clap": "clap|grip|grab|pinch", "home": "home|reset|rest|stop"}

SYSTEM = (
    "You are Marionette, a friendly one-armed robot at a hackathon demo table. The user speaks to you. "
    f"Pick exactly one gesture from: {', '.join(GESTURES)}, or none. Reply in one short, upbeat sentence "
    "(max 15 words) that says what you're doing. If they ask how you work: a webcam tracks their arm "
    "and you copy it live; strike the goalpost pose (arm out, forearm up) to take control."
)


def keyword_command(text: str) -> dict:
    t = text.lower()
    for g, pat in WORDS.items():
        if re.search(pat, t):
            return {"gesture": g, "reply": f"Sure, {g.replace('_', ' ')}!"}
    return {"gesture": "none", "reply": "Try asking me to wave, bow, nod or dance."}


async def command(text: str) -> dict:
    key = os.environ.get("GEMINI_API_KEY")
    text = text.strip()[:300]
    if not key:
        return {**keyword_command(text), "by": "keywords"}
    model = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [{"text": text}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": {"type": "OBJECT", "required": ["gesture", "reply"], "properties": {
                "gesture": {"type": "STRING", "enum": [*GESTURES, "none"]}, "reply": {"type": "STRING"}}},
        },
    }
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as s:
            async with s.post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                              json=body, headers={"x-goog-api-key": key}) as r:
                data = await r.json()
        out = json.loads(data["candidates"][0]["content"]["parts"][0]["text"])
        if out.get("gesture") not in GESTURES:
            out["gesture"] = "none"
        return {"gesture": out["gesture"], "reply": str(out.get("reply", ""))[:200], "by": "gemini"}
    except Exception as e:
        print(f"Gemini failed ({e}); using keywords.")
        return {**keyword_command(text), "by": "keywords"}


async def tts(text: str) -> bytes | None:
    """MP3 bytes for text, cached on disk; None when there is no key or the call fails."""
    key = os.environ.get("ELEVENLABS_API_KEY")
    text = text.strip()[:300]
    if not key or not text:
        return None
    voice = os.environ.get("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
    path = VOICE_CACHE / (hashlib.sha1(f"{voice}:{text}".encode()).hexdigest()[:16] + ".mp3")
    if path.exists():
        return path.read_bytes()
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as s:
            async with s.post(f"https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128",
                              json={"text": text, "model_id": "eleven_flash_v2_5"},
                              headers={"xi-api-key": key}) as r:
                if r.status != 200:
                    print(f"ElevenLabs {r.status}: {(await r.text())[:120]}")
                    return None
                audio = await r.read()
    except Exception as e:
        print(f"ElevenLabs failed: {e}")
        return None
    VOICE_CACHE.mkdir(exist_ok=True)
    path.write_bytes(audio)
    return audio


VISION_PROMPT = (
    "A filmstrip of one arm movement, frames numbered left to right, oldest first. Each frame is cropped to the "
    "person, with their tracked skeleton drawn in (lines = arms). Say what the arm did and where it ended. "
    "Angles in degrees from the person's point of view: upper_arm and forearm = angle above level (+ up, - down), "
    "hand = where the hand points above level, pan = arm direction seen from above: 0 = straight out to the person's side, + = swung forward toward the camera, - = swung back. "
    "grip = open or closed hand at the end."
)
VISION_SCHEMA = {"type": "OBJECT", "required": ["did", "upper_arm", "forearm", "hand", "pan", "grip"], "properties": {
    "did": {"type": "STRING"}, "upper_arm": {"type": "NUMBER"}, "forearm": {"type": "NUMBER"},
    "hand": {"type": "NUMBER"}, "pan": {"type": "NUMBER"}, "grip": {"type": "STRING", "enum": ["open", "closed"]}}}


async def vision(image_b64: str) -> dict:
    """One movement filmstrip (JPEG, base64) -> what the arm did and its end pose. Gemini first, then Perplexity."""
    t0 = time.time()
    try:
        if os.environ.get("GEMINI_API_KEY") and os.environ.get("VISION_PROVIDER", "gemini") == "gemini":
            model = os.environ.get("VISION_MODEL", "gemini-3.5-flash-lite")
            body = {"contents": [{"parts": [{"text": VISION_PROMPT}, {"inline_data": {"mime_type": "image/jpeg", "data": image_b64}}]}],
                    "generationConfig": {"responseMimeType": "application/json", "responseSchema": VISION_SCHEMA,
                                         "thinkingConfig": {"thinkingLevel": "minimal"}}}
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as s:
                async with s.post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                                  json=body, headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]}) as r:
                    data = await r.json()
            if "error" in data:
                return {"ok": False, "by": model, "error": data["error"].get("message", "")[:160]}
            out = json.loads(data["candidates"][0]["content"]["parts"][0]["text"])
        elif os.environ.get("PERPLEXITY_API_KEY"):
            model = os.environ.get("VISION_MODEL", "sonar")
            body = {"model": model, "messages": [{"role": "user", "content": [
                {"type": "text", "text": VISION_PROMPT + " Reply with JSON only: " + json.dumps(list(VISION_SCHEMA["properties"]))},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + image_b64}}]}],
                "response_format": {"type": "json_schema", "json_schema": {"schema": {
                    "type": "object", "required": VISION_SCHEMA["required"], "properties": {
                        k: {"type": "string" if v["type"] == "STRING" else "number"} for k, v in VISION_SCHEMA["properties"].items()}}}}}
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as s:
                async with s.post("https://api.perplexity.ai/chat/completions", json=body,
                                  headers={"Authorization": "Bearer " + os.environ["PERPLEXITY_API_KEY"]}) as r:
                    data = await r.json()
            if "error" in data:
                return {"ok": False, "by": model, "error": str(data["error"].get("message", data["error"]))[:160]}
            out = json.loads(data["choices"][0]["message"]["content"])
        else:
            return {"ok": False, "by": "none", "error": "No GEMINI_API_KEY or PERPLEXITY_API_KEY in .env"}
        return {"ok": True, "by": model, "ms": round((time.time() - t0) * 1000), "result": out}
    except Exception as e:
        return {"ok": False, "by": "vision", "error": str(e)[:160]}
