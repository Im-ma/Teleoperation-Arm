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

## Run Marionette Live

```
python serve.py                                          # real arm
python serve.py --dry-run --no-browser --http-port 8000  # no arm, just the site
```

Open http://localhost:8000. Use `?video=/web/clip.mp4` to drive the page from a recorded
clip instead of your webcam (handy for testing without a person in frame).

**Flow:** strike the goalpost pose (upper arm down, forearm forward) and hold it for 1 s to
lock on; the robot then mirrors you live. If tracking is lost it holds and auto re-locks when
you (or the same framing) come back; after 10 s with nobody there it glides home.

**Keys:** `Esc` stop, `G` hold-to-talk, `M` mute, `R` reset.

**Keys/env (`.env` at repo root, gitignored):** `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`
(optional), `GEMINI_API_KEY`, `GEMINI_MODEL` (optional), `TIGER_DATABASE_URL` (optional). These
are read only by `serve.py`/`sponsors.py` on the server; the browser never sees them.

**Replay:** past sessions play back at `/web/replay.html`.
