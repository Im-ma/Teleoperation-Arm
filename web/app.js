// Marionette Live: stand in front of the camera, strike the goalpost pose, and the
// robot becomes your arm. No calibration. See docs/ARCHITECTURE.md.
import { FilesetResolver, PoseLandmarker, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { JOINTS, clamp, mapMatchedPose, syncPose, wrap } from "./mapping.mjs";
import { GOALPOST, armFeatures, framing, goalpostScore } from "./angles.mjs";
import { FeatureFilter } from "./filters.mjs";
import { createMirror } from "./mirror.mjs";
import { LINES, createVoice } from "./voice.js";
import { createCommands } from "./command.js";
import { createRobot } from "./robot.mjs";

const $ = s => document.querySelector(s);
const view = $("#view"), ctx = view.getContext("2d"), video = $("#video");
const params = new URLSearchParams(location.search);
const LABEL = { shoulder_pan: "base", shoulder_lift: "shoulder", elbow_flex: "elbow", wrist_flex: "wrist", wrist_roll: "roll", gripper: "grip" };
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} };
const finiteJoints = j => Object.fromEntries(Object.entries(j).filter(([, v]) => Number.isFinite(v)));

// Twin-only goalpost (no robot): upper link out, forearm up, gripper back across.
const SIM_READY = { shoulder_pan: 0, shoulder_lift: -90, elbow_flex: 0, wrist_flex: 90, wrist_roll: 0, gripper: 60 };
const SIM_LIMITS = Object.fromEntries(JOINTS.map(j => [j, j === "gripper" ? [0, 100] : [-135, 135]]));

const S = {
  robot: "offline", mode: "idle", msg: "", engaged: false, limits: {}, ready: null, obs: {},
  target: { ...SIM_READY }, flip: load("mirrorFlip-v1", {}), ref: null, stream: null, fps: 0,
  hist: [], lastArm: "right", sim: false,
};
const live = () => S.robot === "live";
const robotZero = () => (live() && S.ready ? S.ready : SIM_READY);
const limits = () => (live() ? S.limits : SIM_LIMITS);
let M = createMirror();
const filt = new FeatureFilter();

// ---------- voice + commands ----------
const voice = createVoice({});
voice.preload();
const chat = (html) => { $("#chat").innerHTML = html };
const commands = createCommands({
  isDriving: () => M.state === "MIRRORING",
  onHeard: t => chat(`<b>You:</b> ${esc(t)}`),
  onReply: r => {
    chat(`${$("#chat").innerHTML}<br><b>Robot:</b> ${esc(r.reply || "")} <small>${r.by === "gemini" ? "· Gemini" : ""}</small>`);
    if (r.reply) voice.free(r.reply);
    if (!r.played && r.frames?.length) playTwin(r.frames);   // no robot: the twin performs it
  },
});
const esc = t => t.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
$("#cmdGo").onclick = () => { commands.run($("#cmdText").value); $("#cmdText").value = "" };
$("#cmdText").onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") $("#cmdGo").click() };
const unlockAudio = () => voice.unlock().then(pills);
addEventListener("pointerdown", unlockAudio);
$("#pVoice").onclick = () => { voice.muted = !voice.muted; pills() };

// Gesture keyframes on the twin only (the bridge plays them on the real arm).
let twinGestureUntil = 0;
function playTwin(frames) {
  frames.forEach((f, i) => setTimeout(() => {
    if (M.state === "MIRRORING") return;
    S.target = Object.fromEntries(JOINTS.map(j => [j, robotZero()[j] + (f[j] || 0)]));
  }, i * 550));
  twinGestureUntil = performance.now() + frames.length * 550 + 300;
}

// ---------- vision ----------
let pose, hands;
async function initVision() {
  const fs = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm");
  const mk = (C, file, extra = {}) => C.createFromOptions(fs, { baseOptions: { modelAssetPath: `/models/${file}`, delegate: "GPU" }, runningMode: "VIDEO", ...extra });
  [pose, hands] = await Promise.all([mk(PoseLandmarker, "pose_landmarker_full.task"), mk(HandLandmarker, "hand_landmarker.task", { numHands: 2 })]);
}

async function startCamera() {
  const src = params.get("video");   // ?video=/web/clip.mp4 replays a recording instead of the webcam
  if (src) { video.src = src; video.loop = true }
  else {
    S.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: 1280, height: 720, facingMode: "user" } });
    video.srcObject = S.stream;
  }
  // Chrome may pause a muted video while the page is in the background; keep nudging it.
  await video.play().catch(() => {});
  setInterval(() => { if (video.paused) video.play().catch(() => {}) }, 1000);
  if (video.readyState < 1) await new Promise(r => video.addEventListener("loadedmetadata", r, { once: true }));
  view.width = video.videoWidth; view.height = video.videoHeight;
  $("#gate").innerHTML = "<div><h1>Loading the tracker…</h1><p>First time takes a few seconds.</p></div>";
  if (!pose) await initVision();
  $("#gate").hidden = true;
  frame(performance.now());
  if (src) {   // recorded clip: keep tracking even in a background tab, and expose state for tests
    setInterval(() => document.hidden && frame(performance.now()), 50);
    window.__mirror = { get state() { return M.state }, get arm() { return M.arm }, S, get person() { return lastR && { arm: lastR.arm, f: lastR.f } } };
  }
  pills();
}
$("#start").onclick = () => { unlockAudio(); startCamera().catch(e => { $("#gate").querySelector("p").textContent = "Couldn't start the camera: " + e.message }) };

// ---------- main loop ----------
let lastT = -1, fpsT = 0, fpsN = 0, lastSend = 0, lastR = null, lastOut = { state: "BOOT" };
let rafPending = false, lastTs = 0, wasHidden = false;
function frame(now) {
  if (!rafPending) { rafPending = true; requestAnimationFrame(t => { rafPending = false; frame(t) }) }
  // Backgrounded tab: some browsers keep an active camera stream running near full rate,
  // so don't rely on rAF throttling alone. Stop sending targets and let go of the robot.
  // The recorded-clip path (?video=) is exempt: it's used for headless tracking tests.
  if (document.hidden && !params.get("video")) {
    if (!wasHidden) { wasHidden = true; send({ type: "engage", on: false }) }
    return;
  }
  wasHidden = false;
  if (video.readyState < 2 || video.currentTime === lastT) return;
  lastT = video.currentTime;
  const w = view.width, h = view.height;
  now = lastTs = Math.max(lastTs + 1, now);   // MediaPipe needs strictly increasing timestamps
  const pr = pose.detectForVideo(video, now), hr = hands.detectForVideo(video, now);
  const L = pr.landmarks?.[0], W = pr.worldLandmarks?.[0];

  // Before locking, whichever arm is closer to the goalpost is the candidate.
  let r = null;
  if (L) {
    const arms = ["right"].map(a => armFeatures(L, W, hr, a, w, h)).filter(Boolean);
    arms.sort((a, b) => goalpostScore(b) - goalpostScore(a) + 0.01 * ((b.arm === S.lastArm) - (a.arm === S.lastArm)));
    r = arms[0] || null;
  }
  if (r && r.arm !== S.lastArm) { filt.reset(); S.lastArm = r.arm }
  const fs = r ? filt.update(r.f, r.conf, now / 1000) : null;
  if (fs) { S.hist.push({ t: now, f: { ...fs } }); while (S.hist.length && now - S.hist[0].t > 700) S.hist.shift() }

  // Hand not seen yet at lock: take its zero from the first good reading instead of a guess.
  if (S.ref?.lazy && fs) for (const k in S.ref.lazy) if (Number.isFinite(fs[k])) { S.ref.humanZero[k] = fs[k]; delete S.ref.lazy[k] }
  // Which way the tracked arm reaches out on the (mirrored) screen: the twin is viewed from that side.
  const fr = r && framing(r, w, h);
  const person = r && { arm: r.arm, core: r.conf.lift >= 0.6 && r.conf.elbow >= 0.6, straight: Math.abs(r.f.lift) < 25 && Math.abs(r.f.elbow) < 30, score: goalpostScore(r), framing: fr, id: { cx: r.F.mid[0] / w, sw: r.F.sw / w } };
  const out = M.tick({ now, live: live(), engaged: S.engaged, robotReady: !live() || S.mode === "idle", person });
  const fromHold = out.actions.includes("reset");   // HOLD → MIRRORING: welcome back, blend in gently
  for (const a of out.actions) act(a, fs, now, fromHold);
  if (out.say) { if (out.say === "hello") voice.newPerson(); voice.say(out.say) }
  if (M.state !== "MIRRORING" && M.state !== "HOLD" && now > twinGestureUntil) S.target = { ...robotZero() };

  draw(pr, r, fr, out);
  caption(out, fr);
  lastR = r; lastOut = out;
  if (++fpsN && now - fpsT > 1000) { S.fps = Math.round(fpsN * 1000 / (now - fpsT)); fpsN = 0; fpsT = now; pills() }
  if (out.state !== lastState) { lastState = out.state; states(); pills() }
  if ($("#debug").open) bars();
}
let lastState = "";

function act(a, fs, now, fromHold) {
  if (a === "lock") {
    const med = k => { const v = S.hist.map(s => s.f[k]).filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : undefined };
    S.ref = {
      version: 1, arm: M.arm, physical: live(), robotZero: { ...robotZero() }, pinch: 0.12,
      lazy: Object.fromEntries(["wrist", "roll"].filter(k => med(k) === undefined).map(k => [k, 1])),
      humanZero: { lift: med("lift") ?? 0, elbow: med("elbow") ?? 0, pan: 0, wrist: med("wrist") ?? 90, roll: med("roll") ?? 0, grip: Math.max(0.35, med("grip") ?? 0.8) },
    };
    S.target = { ...S.ref.robotZero };
  } else if (a === "engage") {
    if (fs) S.target = { ...S.target, ...mapMatchedPose(fs, S.ref, limits(), S.flip), shoulder_pan: S.ref.robotZero.shoulder_pan, wrist_roll: S.ref.robotZero.wrist_roll };
    send({ type: "target", joints: finiteJoints(S.target) });
    // Re-engaging after HOLD can find the person's arm well away from where they left off; blend in slower.
    send({ type: "engage", on: true, blend_s: fromHold ? 2.5 : 1.5 });
  } else if (a === "send" && fs && S.ref) {
    S.target = { ...S.target, ...mapMatchedPose(fs, S.ref, limits(), S.flip), shoulder_pan: S.ref.robotZero.shoulder_pan, wrist_roll: S.ref.robotZero.wrist_roll };
    if (now - lastSend > 33) { send({ type: "target", joints: finiteJoints(S.target) }); lastSend = now }
  } else if (a === "disengage") send({ type: "engage", on: false });
  else if (a === "home") send({ type: "home" });
  else if (a === "reset") filt.reset();
}

// ---------- drawing ----------
function draw(pr, r, fr, out) {
  const w = view.width, h = view.height;
  const P = p => [p.x * w, p.y * h];
  const line = (a, b) => { ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke() };
  ctx.save(); ctx.translate(w, 0); ctx.scale(-1, 1);            // mirror, like a mirror
  ctx.drawImage(video, 0, 0, w, h);
  ctx.fillStyle = "rgba(8,9,11,.35)"; ctx.fillRect(0, 0, w, h);
  const L = pr.landmarks?.[0], st = out.state, mirroring = st === "MIRRORING";
  ctx.lineCap = ctx.lineJoin = "round";

  // ghost goalpost: where your arm should go
  if (st === "HOMING" || st === "BOOT") ghost(r, 0);
  if (L) {
    ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 3;
    for (const [a, b] of [[11, 12], [11, 23], [12, 24], [23, 24], [12, 14], [14, 16]]) line(P(L[a]), P(L[b]));   // torso + your right arm only
  }
  if (r) {
    const [s, e, wr] = r.idx.map(i => P(L[i])), c = mirroring ? "#c8ff3d" : st === "HOLD" ? "#ffb13d" : "#ffffff";
    ctx.strokeStyle = c; ctx.shadowColor = c; ctx.shadowBlur = mirroring ? 28 : 10; ctx.lineWidth = 12;
    ctx.beginPath(); ctx.moveTo(...s); ctx.lineTo(...e); ctx.lineTo(...wr); ctx.stroke(); ctx.shadowBlur = 0;
    for (const p of [s, e, wr]) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(...p, 8, 0, 7); ctx.fill() }
    if (r.H) {
      ctx.strokeStyle = "#5ad1ff"; ctx.lineWidth = 3;
      for (const [a, b] of [[0, 5], [5, 9], [9, 13], [13, 17], [0, 17], [1, 2], [2, 3], [3, 4], [5, 6], [6, 7], [7, 8], [9, 12], [13, 16], [17, 20]]) line(P(r.H[a]), P(r.H[b]));
    }
    if (out.ring > 0) {                                            // lock ring around the hand
      const c2 = r.H ? P(r.H[9]) : wr, rr = Math.max(40, r.F.sw * 0.35);
      ctx.lineWidth = 10; ctx.strokeStyle = "rgba(255,255,255,.15)"; ctx.beginPath(); ctx.arc(...c2, rr, 0, 7); ctx.stroke();
      ctx.strokeStyle = "#c8ff3d"; ctx.shadowColor = "#c8ff3d"; ctx.shadowBlur = 20;
      ctx.beginPath(); ctx.arc(...c2, rr, -Math.PI / 2, -Math.PI / 2 + out.ring * Math.PI * 2); ctx.stroke(); ctx.shadowBlur = 0;
    }
  }
  ctx.restore();
  const m = $("#meter");
  m.hidden = !fr || mirroring;
  if (fr) $("#meterDot").style.top = `${(1 - clamp((fr.meter - 0.3) / 0.9, 0, 1)) * 100}%`;
}

// The pose to copy, drawn from the person's own shoulder (or a stand-in figure).
function ghost(r, ring) {
  const w = view.width, h = view.height;
  let S0, x, y, sw;
  if (r) ({ S: S0, x, y, sw } = r.F);
  else { sw = w * 0.13; S0 = [w * 0.5 - sw / 2, h * 0.58]; x = [-1, 0]; y = [0, -1] }   // their right arm = image left
  const at = (a, b) => [S0[0] + (x[0] * a + y[0] * b) * sw, S0[1] + (x[1] * a + y[1] * b) * sw];
  ctx.save();
  ctx.setLineDash([14, 12]); ctx.lineWidth = 16; ctx.strokeStyle = `rgba(200,255,61,${0.25 + 0.5 * ring})`;
  ctx.beginPath(); ctx.moveTo(...at(0, 0)); ctx.lineTo(...at(0.95, 0)); ctx.lineTo(...at(0.95, 0.95)); ctx.lineTo(...at(0.55, 1.05)); ctx.stroke();
  if (!r) {
    ctx.lineWidth = 6; ctx.strokeStyle = "rgba(255,255,255,.25)";
    ctx.beginPath(); ctx.moveTo(...at(0, 0)); ctx.lineTo(...at(-1, 0)); ctx.moveTo(...at(-0.5, 0)); ctx.lineTo(...at(-0.5, -1.4)); ctx.stroke();
    ctx.beginPath(); ctx.arc(...at(-0.5, 0.55), sw * 0.28, 0, 7); ctx.stroke();
  }
  ctx.restore();
}

// ---------- words on screen ----------
const STATE_TEXT = {
  BOOT: ["starting", "Waking up…"], HOMING: ["getting ready", "Getting into position…"],
  WAITING: ["waiting", "Step up and copy me."], ACQUIRING: ["your turn", ""],
  MIRRORING: ["live · mirroring you", "I'm your arm now."], HOLD: ["holding", LINES.lost],
};
const HINT_TEXT = { ...LINES, strike: "Stretch your right arm straight out, like the robot.", hold: "Hold it…" };
function caption(out, fr) {
  const [small, big] = STATE_TEXT[out.state];
  const text = (out.hint && HINT_TEXT[out.hint]) || big;
  const el = $("#caption");
  $("#stateName").textContent = small;
  if ($("#capText").textContent !== text) $("#capText").textContent = text;
  el.className = "caption" + (out.state === "MIRRORING" && !out.hint ? " live" : out.hint && out.hint !== "hold" && out.hint !== "strike" ? " warn" : "");
}
function states() {
  $("#states").innerHTML = ["WAITING", "ACQUIRING", "MIRRORING", "HOLD", "HOMING"].map(s => `<span class="${M.state === s ? "on" : ""}">${s.toLowerCase()}</span>`).join("");
  $("#twin").classList.toggle("live", M.state === "MIRRORING");
}
function pill(id, cls, text) { const el = $(id); el.className = "pill " + cls; el.lastElementChild.textContent = text }
function pills() {
  pill("#pCam", S.stream || params.get("video") ? "ok" : "", S.stream ? "camera on" : params.get("video") ? "recording" : "camera off");
  pill("#pTrack", lastR ? "ok" : "warn", lastR ? `${lastR.arm} arm · ${S.fps} fps` : "no one in view");
  const b = { live: ["ok", S.engaged ? "robot · engaged" : "robot · " + S.mode], sim: ["warn", "twin only"], connecting: ["warn", "connecting…"], error: ["bad", "robot error"], offline: ["bad", "bridge offline"] }[S.robot] || ["", S.robot];
  pill("#pBot", ...b);
  pill("#pVoice", voice.muted ? "" : voice.unlocked ? "ok" : "warn", voice.muted ? "muted" : voice.unlocked ? "voice on" : "click for voice");
  $("#fps").textContent = S.msg;
}

// ---------- bridge ----------
let ws;
function connectWS() {
  const key = new URLSearchParams(location.hash.slice(1)).get("key") || "";
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws${key ? "?key=" + encodeURIComponent(key) : ""}`);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === "status") {
      Object.assign(S, { robot: m.robot, msg: m.msg, mode: m.mode, engaged: m.engaged, limits: m.limits || S.limits, ready: m.ready || S.ready });
      tools(); pills();
    } else if (m.type === "obs") S.obs = m.joints;
    else if (m.type === "selftest") $("#botMsg").textContent = m.results.map(r => `${r.ok ? "✓" : "✗"} ${LABEL[r.joint]}`).join("  ");
  };
  ws.onclose = () => { Object.assign(S, { robot: "offline", engaged: false, msg: "Bridge offline: run python bridge.py" }); pills(); setTimeout(connectWS, 1500) };
}
const send = m => ws?.readyState === 1 && ws.send(JSON.stringify(m));

// ---------- keys ----------
addEventListener("keydown", e => {
  if (e.repeat) return;
  unlockAudio();
  if (e.key === "Escape") { const o = M.stop(performance.now()); o.actions.forEach(a => act(a)); voice.say(o.say) }
  else if (e.key === "r" || e.key === "R") { send({ type: "engage", on: false }); send({ type: "home" }); M = createMirror(); filt.reset() }
  else if (e.key === "m" || e.key === "M") { voice.muted = !voice.muted; pills() }
  else if ((e.key === "g" || e.key === "G") && commands.start()) chat("Listening…");
});
addEventListener("keyup", e => { if (e.key === "g" || e.key === "G") commands.stop() });

// ---------- debug panel: joints, flips, robot tools ----------
$("#joints").innerHTML = JOINTS.map(j => `<div class="joint"><span>${LABEL[j]}</span><div class="bar"><s id="a_${j}"></s><b id="t_${j}"></b></div><span id="v_${j}">–</span></div>`).join("");
$("#flips").innerHTML = "Reverse: " + JOINTS.map(j => `<label><input type="checkbox" data-j="${j}" ${S.flip[j] ? "checked" : ""}>${LABEL[j]}</label>`).join("");
$("#flips").onchange = e => { S.flip[e.target.dataset.j] = e.target.checked; save("mirrorFlip-v1", S.flip) };
$("#home").onclick = () => send({ type: "home" });
$("#test").onclick = () => send({ type: "selftest" });
$("#limp").onclick = () => send({ type: "limp", on: S.mode !== "limp" });
$("#saveReady").onclick = () => send({ type: "save_ready" });
function tools() {
  const idle = live() && S.mode === "idle" && M.state !== "MIRRORING";
  $("#home").disabled = !idle; $("#test").disabled = !idle;
  $("#limp").disabled = !(live() && (S.mode === "limp" || idle));
  $("#limp").textContent = S.mode === "limp" ? "🔒 Lock arm" : "✋ Pose by hand";
  $("#saveReady").hidden = S.mode !== "limp";
  $("#botMsg").textContent = S.msg;
}
function bars() {
  for (const j of JOINTS) {
    const [lo, hi] = limits()[j] || [-135, 135], pos = v => `${clamp((v - lo) / (hi - lo), 0, 1) * 100}%`;
    const t = S.target[j], a = S.obs[j];
    if (t !== undefined) { $("#t_" + j).style.left = pos(t); $("#v_" + j).textContent = t.toFixed(0) + (j === "gripper" ? "%" : "°") }
    if (a !== undefined) $("#a_" + j).style.left = pos(a);
  }
}

// ---------- digital twin ----------
function makeTwin(el) {
  // Keep the twin cheap: the STL meshes are heavy and share the GPU with MediaPipe, and a slow tab means jittery tracking.
  const r = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  r.setPixelRatio(1); el.appendChild(r.domElement);
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(38, 1, 0.01, 10);
  cam.position.set(0, 0.2, -0.8);
  let viewSide = 1;
  const ctl = new OrbitControls(cam, r.domElement); ctl.target.set(0, 0.19, 0); ctl.enableDamping = true; ctl.enablePan = false;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x1a2230, 1.5));
  const dl = new THREE.DirectionalLight(0xffffff, 2.4); dl.position.set(1, 2, -1.2); scene.add(dl);
  scene.add(new THREE.GridHelper(1.2, 24, 0x2a2f37, 0x181b20));
  // Real SO-101 CAD (official URDF + STL meshes); its joint degrees match the motors' calibrated degrees.
  let robot = null;
  createRobot().then(m => { robot = m; scene.add(m.root) }).catch(e => console.warn("robot model", e));
  const cur = {}, rad = d => d * Math.PI / 180;
  const tick = () => {
    requestAnimationFrame(tick);
    const w = el.clientWidth, h = el.clientHeight;
    if (r.domElement.width !== Math.round(w * devicePixelRatio)) { r.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix() }
    const side = -1;   // twin points the same way as your arm on the mirrored screen
    if (side !== viewSide) { viewSide = side; cam.position.set(0, 0.2, -0.8 * side); dl.position.set(1, 2, -1.2 * side) }
    const measured = live() && S.obs.shoulder_pan !== undefined;
    const src = measured ? S.obs : S.target;
    $("#twinLabel").textContent = measured ? "robot · measured" : "twin · target";
    for (const j of JOINTS) { const t = src[j] ?? 0; cur[j] = (cur[j] ?? t) + 0.25 * (t - (cur[j] ?? t)) }
    if (robot && JOINTS.every(j => Number.isFinite(cur[j]))) robot.setPose(cur);
    ctl.update(); r.render(scene, cam);
  };
  tick();
}

// ---------- go ----------
if (params.has("demo")) document.body.classList.add("demo");
makeTwin($("#twin"));
connectWS();
states(); pills();
// Start on our own when the camera is already allowed (no click needed at the demo table).
if (params.get("video")) $("#start").click();
else navigator.permissions?.query({ name: "camera" }).then(p => { if (p.state === "granted") $("#start").click() }).catch(() => {});
