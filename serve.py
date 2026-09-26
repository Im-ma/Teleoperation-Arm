"""One process: website + camera tracking + the one SO-101 arm.

  python serve.py
  python serve.py --port COM3 --id my_arm

Open http://localhost:8000 — the page tracks your arm and this process drives the robot.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import sys
import time
import webbrowser
from pathlib import Path

import _bootstrap  # noqa: F401
import numpy as np
from aiohttp import WSMsgType, web

from so101_teleop.constants import CALIBRATION_DIR
from so101_teleop.pose_mapping import JOINTS, limits_from_calibration

import sponsors
from telemetry import Telemetry

sponsors.load_env()

HERE = Path(__file__).resolve().parent
WEB_DIR = HERE / "web"
MODEL_DIR = HERE / "models"
POSES = HERE / "poses.json"
KEY_FILE = HERE / ".key"
HZ = 30
MAX_STEP = 4.0
HOME_STEP = 1.5
BLEND_S = 1.5
TEST_DELTA = 12.0
GESTURE_STEP = 3.0  # degrees per tick for gestures, about 90 deg/s
DEADMAN_S = 0.4     # no target from the page for this long: hold still
READY_DEFAULT = {**{j: 0.0 for j in JOINTS}, "gripper": 10.0}


def list_ports() -> list[str]:
    if sys.platform == "win32":
        from serial.tools.list_ports import comports

        ranked = []
        for port in comports():
            blob = f"{port.description} {port.hwid}".upper()
            score = int(any(tag in blob for tag in ("USB", "SERIAL", "CH340", "CP210", "FTDI", "MODEM")))
            ranked.append((score, port.device, port.description))
        ranked.sort(reverse=True)
        return [device for _, device, _ in ranked]
    found = []
    for pattern in ("tty.usbmodem*", "ttyACM*", "ttyUSB*"):
        found.extend(sorted(Path("/dev").glob(pattern)))
    return [str(path) for path in found]


def describe_ports() -> str:
    if sys.platform != "win32":
        return ", ".join(list_ports()) or "none"
    from serial.tools.list_ports import comports

    return ", ".join(f"{p.device} ({p.description})" for p in comports()) or "none"


def find_calibration(robot_id: str) -> tuple[str, Path]:
    folders = [
        CALIBRATION_DIR / "robots" / "so_follower",
        Path.home() / ".cache/huggingface/lerobot/calibration/robots/so_follower",
    ]
    wanted = [robot_id, "my_arm", "my_follower", "follower"]
    for folder in folders:
        for name in wanted:
            if (folder / f"{name}.json").is_file():
                return name, folder
    for folder in folders:
        if folder.is_dir():
            files = sorted(folder.glob("*.json"))
            if files:
                return files[0].stem, folder
    return robot_id, folders[0]


def limits(robot=None):
    calibration = getattr(robot, "calibration", None) if robot is not None else None
    if not calibration:
        _id, folder = find_calibration("my_arm")
        path = folder / f"{_id}.json"
        if path.exists():
            calibration = json.loads(path.read_text())
    mapped = limits_from_calibration(calibration)
    return {joint: [lo, hi] for joint, (lo, hi) in mapped.items()}


def load_ready():
    try:
        return {**READY_DEFAULT, **json.loads(POSES.read_text())["ready"]}
    except Exception:
        return dict(READY_DEFAULT)


class Bridge:
    def __init__(self, port: str | None = None, robot_id: str = "my_arm", connect_robot: bool = True):
        self.preferred_port = port
        self.requested_id = robot_id
        self.connect_robot = connect_robot
        self.robot, self.state, self.msg = None, "sim", "No arm connected. The twin still follows you."
        self.mode = "idle"
        self.target, self.cmd, self.obs, self.goal, self.hold = {}, {}, {}, {}, {}
        self.blend, self.errors, self.clients, self.task, self.seen = 0.0, 0, set(), None, False
        self.lock = asyncio.Lock()
        self.lim, self.ready = limits(), load_ready()
        self.blend_s, self.target_t, self.tele = BLEND_S, 0.0, Telemetry()

    async def send_all(self, m):
        for ws in list(self.clients):
            try:
                await ws.send_json(m)
            except Exception:
                self.clients.discard(ws)

    def status(self):
        cal_id = str(getattr(self.robot, "calibration_fpath", "") or "") if self.robot else None
        return {
            "type": "status",
            "robot": self.state,
            "msg": self.msg,
            "mode": self.mode,
            "engaged": self.mode == "engaged",
            "limits": self.lim,
            "ready": self.ready,
            "calibration_id": cal_id,
            "ports": list_ports(),
            "keys": sponsors.keys(),
        }

    async def say(self, msg, mode=None):
        self.msg, self.mode = msg, mode or self.mode
        await self.send_all(self.status())

    def clip(self, pose):
        return {j: float(np.clip(v, *self.lim.get(j, (-180, 180)))) for j, v in pose.items() if j in JOINTS}

    async def io(self, fn, *a, **kw):
        async with self.lock:
            return await asyncio.to_thread(fn, *a, **kw)

    async def read(self):
        o = await self.io(self.robot.get_observation)
        self.obs = {k.removesuffix(".pos"): float(v) for k, v in o.items() if k.endswith(".pos")}
        return self.obs

    def run(self, coro):
        self.stop_task()
        self.task = asyncio.create_task(coro)

    def stop_task(self):
        if self.task and not self.task.done():
            self.task.cancel()

    def _candidate_ports(self) -> list[str]:
        if self.preferred_port:
            return [self.preferred_port]
        return list_ports()

    async def connect(self):
        if self.robot:
            return
        found = self._candidate_ports()
        if not found:
            return await self.say(
                f"No arm on USB. Ports seen: {describe_ports()}. "
                "Plug in the arm (USB + power) or pass --port COM3."
            )
        self.state = "connecting"
        await self.say(f"Connecting on {found[0]}…")
        try:
            from so101_teleop.robots.config_so_follower import SO101FollowerConfig
            from so101_teleop.robots.so_follower import SO101Follower

            robot_id, cal_dir = find_calibration(self.requested_id)
            r = SO101Follower(
                SO101FollowerConfig(
                    port=found[0],
                    id=robot_id,
                    calibration_dir=cal_dir,
                    disable_torque_on_disconnect=False,
                )
            )
            last_error = None
            for attempt in range(3):
                try:
                    await asyncio.to_thread(r.connect, False)
                    last_error = None
                    break
                except Exception as exc:
                    last_error = exc
                    try:
                        r.bus.port_handler.closePort()
                    except Exception:
                        pass
                    await asyncio.sleep(0.5)
            if last_error is not None:
                raise last_error
            if not r.calibration:
                onboard = await asyncio.to_thread(r.bus.read_calibration)
                r.calibration = onboard
                r.bus.calibration = onboard
                await asyncio.to_thread(r._save_calibration)
            self.robot, self.lim, self.state = r, limits(r), "live"
            self.cmd = dict(await self.read())
            self.run(self.home())
        except Exception as e:
            self.robot, self.state = None, "error"
            await self.say(f"Couldn't reach the arm: {e}", "idle")

    async def drop(self, why):
        self.stop_task()
        r, self.robot = self.robot, None
        self.state, self.mode, self.msg = "error", "idle", why
        if r:
            try:
                await asyncio.to_thread(r.disconnect)
            except Exception:
                pass
        await self.send_all(self.status())

    async def move_to(self, goal, timeout=12, settle=0.7):
        self.goal = self.clip(goal)
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout and any(abs(self.cmd.get(j, 1e9) - v) > 0.01 for j, v in self.goal.items()):
            await asyncio.sleep(0.1)
        await asyncio.sleep(settle)
        return {j: self.obs[j] - v for j, v in self.goal.items() if j in self.obs}

    async def home(self):
        await self.say("Moving to the ready pose…", "homing")
        err = await self.move_to(self.ready)
        off = [f"{j} {e:+.0f}°" for j, e in err.items() if abs(e) > (8 if j == "gripper" else 5)]
        await self.say("Ready. Engage when you are." if not off else "Near ready, but off: " + ", ".join(off), "idle")

    async def selftest(self):
        await self.say("Self-test: going to ready…", "testing")
        await self.move_to(self.ready)
        results = []
        for j in JOINTS:
            await self.say(f"Self-test: {j.replace('_', ' ')}…")
            base, start = dict(self.goal), self.obs[j]
            lo, hi = self.lim[j]
            d = TEST_DELTA * (2 if j == "gripper" else 1)
            d = d if base[j] + d <= hi else -d
            await self.move_to({**base, j: base[j] + d})
            moved = self.obs[j] - start
            results.append({"joint": j, "want": round(d, 1), "moved": round(moved, 1), "ok": abs(moved - d) < max(3.0, abs(d) * 0.3)})
            await self.send_all({"type": "selftest", "results": results})
            await self.move_to(base)
        bad = [r["joint"] for r in results if not r["ok"]]
        await self.say("Self-test passed: all 6 joints respond." if not bad else "Self-test: check " + ", ".join(bad), "idle")

    async def gesture(self, name):
        await self.say(f"Gesture: {name.replace('_', ' ')}", "gesture")
        await self.move_to(self.ready, timeout=6, settle=0.1)
        for frame in sponsors.GESTURES[name]:
            await self.move_to({j: v + frame.get(j, 0.0) for j, v in self.ready.items()}, timeout=4, settle=0.05)
        await self.say("Ready. Strike the pose to take over.", "idle")

    async def limp(self, on):
        self.stop_task()
        if on:
            await self.io(self.robot.bus.disable_torque)
            return await self.say("Limp: move the arm by hand, then save it as the ready pose.", "limp")
        self.cmd = dict(await self.read())
        await self.io(self.robot.send_action, {f"{j}.pos": v for j, v in self.cmd.items()})
        await self.io(self.robot.bus.enable_torque)
        await self.say("Holding.", "idle")

    async def save_ready(self):
        self.ready = {j: round(v, 1) for j, v in self.clip(await self.read()).items()}
        POSES.write_text(json.dumps({"ready": self.ready}, indent=2))
        await self.say("Saved as the ready pose.")

    async def loop(self):
        tick = 0
        while True:
            await asyncio.sleep(1 / HZ)
            tick += 1
            if not self.robot:
                if self.connect_robot and tick % (2 * HZ) == 0:
                    present = bool(self._candidate_ports())
                    if present and not self.seen:
                        await self.connect()
                    self.seen = present
                continue
            try:
                if tick % 3 == 0:
                    await self.read()
                    await self.send_all({"type": "obs", "joints": self.obs})
                    self.tele.record(self.mode, self.target, self.obs)
                goal, step = None, HOME_STEP
                stale = time.monotonic() - self.target_t
                if self.mode == "engaged" and stale > 2.0:
                    self.tele.end_session()
                    await self.say("Lost the page. Holding position.", "idle")
                elif self.mode == "engaged" and self.target and stale < DEADMAN_S:
                    self.blend = min(1.0, self.blend + 1 / (self.blend_s * HZ))
                    a = self.blend * self.blend * (3 - 2 * self.blend)
                    goal = {j: self.hold.get(j, t) + a * (t - self.hold.get(j, t)) for j, t in self.clip(self.target).items()}
                    step = MAX_STEP
                elif self.mode in ("homing", "testing", "gesture"):
                    goal, step = self.goal, GESTURE_STEP if self.mode == "gesture" else HOME_STEP
                if goal:
                    for j, t in goal.items():
                        s = step * (3 if j == "gripper" else 1)
                        c = self.cmd.get(j, self.obs.get(j, t))
                        self.cmd[j] = c + float(np.clip(t - c, -s, s))
                    await self.io(self.robot.send_action, {f"{j}.pos": v for j, v in self.cmd.items() if j in JOINTS})
                self.errors = 0
            except Exception as e:
                self.errors += 1
                if "not configured" in str(e) or not list_ports():
                    await self.drop("Arm disconnected from USB. Check the cable; it reconnects on its own.")
                elif self.errors > 15:
                    await self.drop(f"Too many bus errors ({e}). Check power and motor cables.")


B = Bridge()
KEY = ""


async def handle(d):
    t = d.get("type")
    if t == "target":
        B.target = {j: float(v) for j, v in d.get("joints", {}).items() if j in JOINTS}
        B.target_t = time.monotonic()
        if not B.robot:
            B.tele.record("sim", B.target, {})
    elif t == "engage" and not B.robot:
        B.tele.start_session("twin") if d.get("on") else B.tele.end_session()
    elif t == "connect":
        await B.connect()
    elif t == "reference" and B.robot:
        await B.read()
    elif not B.robot:
        await B.say("Connect the arm first. On the robot card, press Connect, or restart with --port COM3.")
    elif t == "engage":
        if d.get("on") and B.mode == "idle":
            B.hold, B.blend = dict(B.cmd), 0.0
            B.blend_s = float(np.clip(d.get("blend_s", BLEND_S), 1.0, 3.0))
            B.target_t = time.monotonic()
            B.tele.start_session("mirror")
            await B.say("Engaged: easing onto your pose…", "engaged")
        elif not d.get("on") and B.mode == "engaged":
            B.tele.end_session()
            await B.say("Stopped. Holding position.", "idle")
        else:
            await B.send_all(B.status())
    elif t == "gesture" and B.mode == "idle" and d.get("name") in sponsors.GESTURES:
        B.run(B.gesture(d["name"]))
    elif t == "home" and B.mode != "limp":
        B.run(B.home())
    elif t == "selftest" and B.mode == "idle":
        B.run(B.selftest())
    elif t == "limp" and B.mode in ("idle", "limp"):
        await B.limp(bool(d.get("on")))
    elif t == "save_ready" and B.mode == "limp":
        await B.save_ready()


async def ws_handler(req):
    ws = web.WebSocketResponse(heartbeat=10)
    await ws.prepare(req)
    B.clients.add(ws)
    await ws.send_json(B.status())
    if len(B.clients) == 1 and B.robot and B.mode == "idle":
        B.run(B.home())  # a fresh page: glide to the goalpost pose so people know what to copy
    async for m in ws:
        if m.type == WSMsgType.TEXT:
            try:
                data = json.loads(m.data)
            except Exception:
                await ws.send_json({"type": "error", "msg": "Bad JSON"})
                continue
            await handle(data)
    B.clients.discard(ws)
    if not B.clients and B.mode == "engaged":
        B.tele.end_session()
        await B.say("Nobody driving. Holding position.", "idle")
    return ws


async def api_state(_):
    return web.json_response({**B.status(), "joints": B.obs})


async def json_body(req):
    try:
        return await req.json()
    except Exception:
        raise web.HTTPBadRequest(text="Invalid JSON body")


async def api_cmd(req):
    body = await json_body(req) if req.can_read_body else {}
    await handle({**body, "type": req.match_info["cmd"]})
    return web.json_response({**B.status(), "joints": B.obs})


async def api_tts(req):
    body = await json_body(req)
    audio = await sponsors.tts(str(body.get("text", "")))
    return web.Response(body=audio, content_type="audio/mpeg") if audio else web.Response(status=204)


async def api_command(req):
    body = await json_body(req)
    out = await sponsors.command(str(body.get("text", "")))
    g = out["gesture"]
    out["frames"] = sponsors.GESTURES.get(g, [])
    out["played"] = bool(B.robot and B.mode == "idle" and g in sponsors.GESTURES)
    if out["played"]:
        B.run(B.gesture(g))
    return web.json_response(out)


async def api_sessions(_):
    return web.json_response({"sessions": B.tele.list(), "tiger": bool(B.tele.db)})


async def api_telemetry(req):
    return web.json_response({"rows": B.tele.get(req.query.get("session", ""))})


def from_internet(req):
    return req.remote not in ("127.0.0.1", "::1") or any(h in req.headers for h in ("X-Forwarded-For", "Cf-Connecting-Ip"))


@web.middleware
async def auth(req, handler):
    if req.path.startswith(("/ws", "/api")) and from_internet(req):
        key = req.query.get("key") or req.headers.get("Authorization", "").removeprefix("Bearer ")
        if not secrets.compare_digest(key.encode(), KEY.encode()):
            raise web.HTTPUnauthorized(text="Missing or wrong key")
    return await handler(req)


async def index(_):
    return web.FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-store"})


async def start_loop(app):
    from get_models import ensure_models

    ensure_models(MODEL_DIR)
    app["loop"] = asyncio.create_task(B.loop())
    app["tele"] = asyncio.create_task(B.tele.run_writer())
    if B.connect_robot and B._candidate_ports():
        B.seen = True
        asyncio.create_task(B.connect())


def build_app() -> web.Application:
    app = web.Application(middlewares=[auth])
    app.add_routes(
        [
            web.get("/", index),
            web.get("/ws", ws_handler),
            web.get("/api/state", api_state),
            web.get("/api/sessions", api_sessions),
            web.get("/api/telemetry", api_telemetry),
            web.post("/api/tts", api_tts),
            web.post("/api/command", api_command),
            web.post("/api/{cmd}", api_cmd),
            web.static("/models", MODEL_DIR),
            web.static("/web", WEB_DIR),
        ]
    )
    app.on_startup.append(start_loop)
    return app


def run(
    follower_port: str | None = None,
    follower_id: str = "my_arm",
    host: str = "0.0.0.0",
    http_port: int = 8000,
    open_browser: bool = True,
    connect_robot: bool = True,
) -> None:
    global B, KEY
    B = Bridge(port=follower_port, robot_id=follower_id, connect_robot=connect_robot)
    KEY = os.environ.get("MARIONETTE_KEY") or (KEY_FILE.read_text().strip() if KEY_FILE.exists() else "")
    if not KEY:
        KEY = secrets.token_urlsafe(16)
        KEY_FILE.write_text(KEY)

    url = f"http://127.0.0.1:{http_port}"
    print(f"Teleop site: {url}")
    print(f"USB ports: {describe_ports()}")
    if follower_port:
        print(f"Arm port: {follower_port}  id: {follower_id}")
    elif connect_robot:
        print("No --port given; will use the first USB serial port it finds.")
    else:
        print("Robot connect is off (dry run). The 3D twin still follows the camera.")
    if open_browser:
        webbrowser.open(url)
    web.run_app(build_app(), host=host, port=http_port, print=None)


def main() -> None:
    parser = argparse.ArgumentParser(description="SO-101 camera teleop: website + the one arm.")
    parser.add_argument("--port", "--follower-port", dest="follower_port", help="Arm COM/tty port, e.g. COM3")
    parser.add_argument("--id", "--follower-id", dest="follower_id", default="my_arm")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--http-port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="Serve the site without opening the arm.")
    args = parser.parse_args()
    run(
        follower_port=args.follower_port,
        follower_id=args.follower_id,
        host=args.host,
        http_port=args.http_port,
        open_browser=not args.no_browser,
        connect_robot=not args.dry_run,
    )


if __name__ == "__main__":
    main()
