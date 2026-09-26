"""Marionette bridge: serves the web app and drives the SO-101 follower from browser pose targets.

  python bridge.py            # then open http://localhost:8000

The arm connects on its own when plugged in, glides to the ready pose, and waits.
Engaging eases from the robot's pose onto yours, so nothing jumps.
"""
import asyncio, json, os, secrets, time
from pathlib import Path

import numpy as np
from aiohttp import web, WSMsgType

HERE = Path(__file__).parent
CALIB = Path.home() / ".cache/huggingface/lerobot/calibration/robots/so_follower/follower.json"
POSES = HERE / "poses.json"
PORT_GLOB = "tty.usbmodem*"
JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
HZ = 30
MAX_STEP = 4.0    # degrees per tick while you drive, about 120 deg/s
HOME_STEP = 1.5   # degrees per tick for automatic moves, about 45 deg/s
BLEND_S = 1.5     # seconds to ease from the robot's pose onto yours after engaging
TEST_DELTA = 12.0
READY_DEFAULT = {**{j: 0.0 for j in JOINTS}, "gripper": 10.0}   # 0 = middle of each calibrated range


def limits():
    out = {"gripper": [0.0, 100.0]}
    if CALIB.exists():
        for j, v in json.loads(CALIB.read_text()).items():
            if j == "gripper":
                continue
            half = (v["range_max"] - v["range_min"]) / 2 * 360 / 4095
            half = min(half, 150) if j == "wrist_roll" else half   # stay off the encoder wrap point at ±180
            out[j] = [-half + 3, half - 3]
    return out


def load_ready():
    try:
        return {**READY_DEFAULT, **json.loads(POSES.read_text())["ready"]}
    except Exception:
        return dict(READY_DEFAULT)


def ports():
    return sorted(Path("/dev").glob(PORT_GLOB))


class Bridge:
    def __init__(self):
        self.robot, self.state, self.msg = None, "sim", "No arm connected. The twin still follows you."
        self.mode = "idle"   # idle | homing | engaged | testing | limp
        self.target, self.cmd, self.obs, self.goal, self.hold = {}, {}, {}, {}, {}
        self.blend, self.errors, self.clients, self.task, self.seen = 0.0, 0, set(), None, False
        self.lock = asyncio.Lock()
        self.lim, self.ready = limits(), load_ready()

    async def send_all(self, m):
        for ws in list(self.clients):
            try:
                await ws.send_json(m)
            except Exception:
                self.clients.discard(ws)

    def status(self):
        return {"type": "status", "robot": self.state, "msg": self.msg, "mode": self.mode,
                "engaged": self.mode == "engaged", "limits": self.lim, "ready": self.ready}

    async def say(self, msg, mode=None):
        self.msg, self.mode = msg, mode or self.mode
        await self.send_all(self.status())

    def clip(self, pose):
        return {j: float(np.clip(v, *self.lim.get(j, (-180, 180)))) for j, v in pose.items() if j in JOINTS}

    async def io(self, fn, *a):
        async with self.lock:
            return await asyncio.to_thread(fn, *a)

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

    # ---------- connection ----------
    async def connect(self):
        if self.robot:
            return
        found = ports()
        if not found:
            return await self.say("No arm found on USB. Plug in the arm (USB and power).")
        self.state = "connecting"
        await self.say(f"Connecting on {found[0].name}…")
        try:
            from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig
            r = SO101Follower(SO101FollowerConfig(port=str(found[0]), id="follower", disable_torque_on_disconnect=False))
            for attempt in range(3):   # the startup ping sometimes misses a motor
                try:
                    await asyncio.to_thread(r.connect)
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    try:
                        r.bus.port_handler.closePort()
                    except Exception:
                        pass
                    await asyncio.sleep(0.5)
            self.robot, self.lim, self.state = r, limits(), "live"
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

    # ---------- automatic moves ----------
    async def move_to(self, goal, timeout=12):
        """Glide to goal at homing speed, then return how far each joint ended up from it."""
        self.goal = self.clip(goal)
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout and any(abs(self.cmd.get(j, 1e9) - v) > 0.01 for j, v in self.goal.items()):
            await asyncio.sleep(0.1)
        await asyncio.sleep(0.7)   # settle, and let a fresh reading arrive
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

    async def limp(self, on):
        self.stop_task()
        if on:
            await self.io(self.robot.bus.disable_torque)
            return await self.say("Limp: move the arm by hand, then save it as the ready pose.", "limp")
        self.cmd = dict(await self.read())   # hold exactly where the hands left it
        await self.io(self.robot.send_action, {f"{j}.pos": v for j, v in self.cmd.items()})
        await self.io(self.robot.bus.enable_torque)
        await self.say("Holding.", "idle")

    async def save_ready(self):
        self.ready = {j: round(v, 1) for j, v in self.clip(await self.read()).items()}
        POSES.write_text(json.dumps({"ready": self.ready}, indent=2))
        await self.say("Saved as the ready pose.")

    # ---------- 30 Hz control loop ----------
    async def loop(self):
        tick = 0
        while True:
            await asyncio.sleep(1 / HZ)
            tick += 1
            if not self.robot:
                if tick % (2 * HZ) == 0:   # plug-and-go: connect when the arm appears
                    present = bool(ports())
                    if present and not self.seen:
                        await self.connect()
                    self.seen = present
                continue
            try:
                if tick % 3 == 0:
                    await self.read()
                    await self.send_all({"type": "obs", "joints": self.obs})
                goal, step = None, HOME_STEP
                if self.mode == "engaged" and self.target:
                    self.blend = min(1.0, self.blend + 1 / (BLEND_S * HZ))
                    a = self.blend * self.blend * (3 - 2 * self.blend)   # smoothstep
                    goal = {j: self.hold.get(j, t) + a * (t - self.hold.get(j, t)) for j, t in self.clip(self.target).items()}
                    step = MAX_STEP
                elif self.mode in ("homing", "testing"):
                    goal = self.goal
                if goal:
                    for j, t in goal.items():
                        s = step * (3 if j == "gripper" else 1)
                        c = self.cmd.get(j, self.obs.get(j, t))
                        self.cmd[j] = c + float(np.clip(t - c, -s, s))
                    await self.io(self.robot.send_action, {f"{j}.pos": v for j, v in self.cmd.items() if j in JOINTS})
                self.errors = 0
            except Exception as e:
                self.errors += 1
                if "not configured" in str(e) or not ports():
                    await self.drop("Arm disconnected from USB. Check the cable; it reconnects on its own.")
                elif self.errors > 15:
                    await self.drop(f"Too many bus errors ({e}). Check power and motor cables.")


B = Bridge()


async def handle(d):
    """One command, from the web app (WebSocket) or the HTTP API."""
    t = d.get("type")
    if t == "target":
        B.target = {j: float(v) for j, v in d["joints"].items() if j in JOINTS}
    elif t == "connect":
        await B.connect()
    elif not B.robot:
        await B.say("Connect the arm first.")
    elif t == "engage":
        if d.get("on") and B.mode == "idle":
            B.hold, B.blend = dict(B.cmd), 0.0
            await B.say("Engaged: easing onto your pose…", "engaged")
        elif not d.get("on") and B.mode == "engaged":
            await B.say("Stopped. Holding position.", "idle")
        else:
            await B.send_all(B.status())
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
    async for m in ws:
        if m.type == WSMsgType.TEXT:
            await handle(json.loads(m.data))
    B.clients.discard(ws)
    if not B.clients and B.mode == "engaged":
        await B.say("Nobody driving. Holding position.", "idle")
    return ws


async def api_state(_):
    return web.json_response({**B.status(), "joints": B.obs})


async def api_cmd(req):
    body = await req.json() if req.can_read_body else {}
    await handle({**body, "type": req.match_info["cmd"]})
    return web.json_response({**B.status(), "joints": B.obs})


def from_internet(req):
    # tunnels connect from localhost but add a forwarding header
    return req.remote not in ("127.0.0.1", "::1") or any(h in req.headers for h in ("X-Forwarded-For", "Cf-Connecting-Ip"))


@web.middleware
async def auth(req, handler):
    if req.path.startswith(("/ws", "/api")) and from_internet(req):
        key = req.query.get("key") or req.headers.get("Authorization", "").removeprefix("Bearer ")
        if not secrets.compare_digest(key.encode(), KEY.encode()):
            raise web.HTTPUnauthorized(text="Missing or wrong key")
    return await handler(req)


async def index(_):
    return web.FileResponse(HERE / "web/index.html", headers={"Cache-Control": "no-store"})


async def start_loop(app):
    app["loop"] = asyncio.create_task(B.loop())
    if ports():
        B.seen = True
        asyncio.create_task(B.connect())


KEY_FILE = HERE / ".key"
KEY = os.environ.get("MARIONETTE_KEY") or (KEY_FILE.read_text().strip() if KEY_FILE.exists() else "")
if not KEY:
    KEY = secrets.token_urlsafe(16)
    KEY_FILE.write_text(KEY)

app = web.Application(middlewares=[auth])
app.add_routes([web.get("/", index), web.get("/ws", ws_handler),
                web.get("/api/state", api_state), web.post("/api/{cmd}", api_cmd),
                web.static("/models", HERE / "models"), web.static("/web", HERE / "web")])
app.on_startup.append(start_loop)

if __name__ == "__main__":
    print("Marionette on http://localhost:8000   (remote access key is in so101/.key)")
    web.run_app(app, host="0.0.0.0", port=8000, print=None)
