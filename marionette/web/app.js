import { FilesetResolver, PoseLandmarker, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { JOINTS, armAngles, circular, clamp, mapMatchedPose, validReference, wrap } from "./mapping.mjs";

const $ = s => document.querySelector(s);
const panel = $("#panel"), view = $("#view"), ctx = view.getContext("2d"), video = $("#video");
const LABEL = { shoulder_pan: "base", shoulder_lift: "shoulder", elbow_flex: "elbow", wrist_flex: "wrist", wrist_roll: "roll", gripper: "gripper" };
const IDX = { right: [12, 14, 16], left: [11, 13, 15] };
const TOL = { lift: 7, elbow: 8, pan: 8, wrist: 10, grip: 0.12, roll: 14 };
const HOLD = 1100;

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} };
const savedReference = load("matchedPose-v1", null);
const SIM_POSE = { shoulder_pan: 0, shoulder_lift: 0, elbow_flex: 0, wrist_flex: 0, wrist_roll: 0, gripper: 65 };
const SIM_LIMITS = Object.fromEntries(JOINTS.map(j => [j, j === "gripper" ? [0, 100] : [-90, 90]]));

const S = {
  arm: load("arm", "right"), calib: validReference(savedReference) ? savedReference : null,
  flip: load("matchedFlip-v1", {}), draft: {},
  fs: null, raw: null, tracking: false, lastSeen: -1e9, fps: 0,
  robot: "offline", msg: "Looking for the bridge…", engaged: false, limits: {}, obs: {}, target: {},
  step: "intro", stream: null,
};

// ---------- math ----------
const median = v => { const s = v.filter(x => x !== undefined).sort((a, b) => a - b); return s[s.length >> 1] };
const rad = d => d * Math.PI / 180;

// ---------- vision ----------
let pose, hands;
async function initVision() {
  const fs = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm");
  const mk = (C, file, extra = {}) => C.createFromOptions(fs, { baseOptions: { modelAssetPath: `/models/${file}`, delegate: "GPU" }, runningMode: "VIDEO", ...extra });
  [pose, hands] = await Promise.all([mk(PoseLandmarker, "pose_landmarker_full.task"), mk(HandLandmarker, "hand_landmarker.task", { numHands: 2 })]);
}

async function startCamera(deviceId) {
  if (S.engaged) send({ type: "engage", on: false });
  S.fs = S.raw = null; S.lastSeen = -1e9; S.tracking = false;
  S.stream?.getTracks().forEach(t => t.stop());
  S.stream = await navigator.mediaDevices.getUserMedia({
    audio: false, video: deviceId ? { deviceId: { exact: deviceId }, width: 1280, height: 720 } : { width: 1280, height: 720, facingMode: "user" } });
  video.srcObject = S.stream;
  await video.play();
  view.width = video.videoWidth; view.height = video.videoHeight;
  S.cameraId = S.stream.getVideoTracks()[0].getSettings().deviceId;
  if (S.calib && (S.calib.arm !== S.arm || S.calib.cameraId !== S.cameraId)) S.calib = null;
  $("#empty").innerHTML = "<div><b>Loading the tracker…</b>First time takes a few seconds</div>";
  if (!pose) await initVision();
  $("#empty").style.display = "none";
  if (!S.looping) { S.looping = true; requestAnimationFrame(frame); }
  pills();
}

function features(pr, hr) {
  if (!pr.landmarks?.length) return null;
  const [s, e, w] = IDX[S.arm], L = pr.landmarks[0], W = pr.worldLandmarks[0];
  const px = p => [p.x * view.width, p.y * view.height];
  const f = armAngles(W, S.arm);
  if (!f) return null;
  const vis = Math.min(L[11].visibility, L[12].visibility, L[e].visibility, L[w].visibility);
  let H = null, best = 0.15;   // the hand whose wrist sits on this arm's wrist
  for (const h of hr.landmarks || []) { const d = Math.hypot(h[0].x - L[w].x, h[0].y - L[w].y); if (d < best) { best = d; H = h } }
  if (H) {
    const P = H.map(px), d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    f.grip = d2(P[4], P[8]) / (d2(P[0], P[9]) + 1e-6);
    const E = px(L[e]), Wr = px(L[w]), fa = [Wr[0] - E[0], Wr[1] - E[1]], ha = [P[9][0] - P[0][0], P[9][1] - P[0][1]];
    f.wrist = Math.atan2(fa[0] * ha[1] - fa[1] * ha[0], fa[0] * ha[0] + fa[1] * ha[1]) * 180 / Math.PI;
    // Projected hand rotation relative to the forearm, not the screen axes.
    // Monocular projection is still an estimate, especially edge-on.
    f.roll = wrap((Math.atan2(P[17][1] - P[5][1], P[17][0] - P[5][0]) - Math.atan2(fa[1], fa[0])) * 180 / Math.PI);
  }
  return { f, vis, L, H, idx: [s, e, w] };
}

function smooth(f) {
  if (!S.fs) { S.fs = { ...f }; return }
  for (const k in f) {
    if (S.fs[k] === undefined) { S.fs[k] = f[k]; continue }
    const d = circular(k) ? wrap(f[k] - S.fs[k]) : f[k] - S.fs[k];
    const a = Math.min(0.85, 0.2 + 0.6 * Math.abs(d) / (k === "grip" ? 0.3 : 25));
    S.fs[k] = circular(k) ? wrap(S.fs[k] + a * d) : S.fs[k] + a * d;
  }
}

function toRobot(fs) {
  return mapMatchedPose(fs, S.calib, S.calib?.physical ? S.limits : SIM_LIMITS, S.flip);
}

// ---------- main loop ----------
let lastT = -1, fpsT = 0, fpsN = 0, lastSend = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (video.readyState < 2 || video.currentTime === lastT) return;
  lastT = video.currentTime;
  const pr = pose.detectForVideo(video, now), hr = hands.detectForVideo(video, now);
  const r = features(pr, hr);
  if (r && r.vis > 0.6 && r.H) { smooth(r.f); S.raw = r; S.lastSeen = now } else S.raw = null;
  const was = S.tracking;
  S.tracking = now - S.lastSeen < 400;
  draw(r, pr);
  if (++fpsN && now - fpsT > 1000) { S.fps = Math.round(fpsN * 1000 / (now - fpsT)); fpsN = 0; fpsT = now; pills() }
  else if (was !== S.tracking) pills();
  stepTick(now);
  if (S.calib && S.fs) S.target = { ...S.target, ...toRobot(S.fs) };
  if (S.step === "live") {
    if (S.engaged && S.raw && now - lastSend > 33) { send({ type: "target", joints: S.target }); lastSend = now }
    if (S.engaged && !S.tracking) { send({ type: "engage", on: false }); banner("Tracking lost · re-engage when ready", true, 1000) }
    liveBars();
  }
}

function draw(r, pr) {
  const w = view.width, h = view.height;
  const P = p => [p.x * w, p.y * h];
  const line = (a, b) => { ctx.beginPath(); ctx.moveTo(...P(a)); ctx.lineTo(...P(b)); ctx.stroke() };
  const dotp = (p, rr, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(...P(p), rr, 0, 7); ctx.fill() };
  ctx.save(); ctx.translate(w, 0); ctx.scale(-1, 1);   // mirror, like a mirror
  ctx.drawImage(video, 0, 0, w, h);
  ctx.fillStyle = "rgba(8,9,11,.28)"; ctx.fillRect(0, 0, w, h);
  const L = pr.landmarks?.[0];
  if (L) {
    ctx.lineCap = "round"; ctx.strokeStyle = "rgba(255,255,255,.22)"; ctx.lineWidth = 3;
    for (const [a, b] of [[11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16]]) line(L[a], L[b]);
    if (r) {
      const [s, e, wr] = r.idx, c = S.engaged ? "#ff5a5a" : "#c8ff3d";
      ctx.strokeStyle = c; ctx.shadowColor = c; ctx.shadowBlur = 24; ctx.lineWidth = 11;
      line(L[s], L[e]); line(L[e], L[wr]); ctx.shadowBlur = 0;
      for (const i of r.idx) dotp(L[i], 8, "#fff");
    }
  }
  if (r?.H) {
    ctx.strokeStyle = "#5ad1ff"; ctx.lineWidth = 3;
    for (const [a, b] of [[0, 5], [5, 9], [9, 13], [13, 17], [0, 17], [1, 2], [2, 3], [3, 4], [5, 6], [6, 7], [7, 8], [9, 12], [13, 16], [17, 20]]) line(r.H[a], r.H[b]);
    ctx.lineWidth = 5; ctx.strokeStyle = "#fff"; line(r.H[4], r.H[8]);
    for (const p of r.H) dotp(p, 3.5, "#5ad1ff");
  }
  ctx.restore();
}

// ---------- status ----------
function pill(id, cls, text) { const el = $(id); el.className = "pill " + cls; el.lastElementChild.textContent = text }
function pills() {
  pill("#pCam", S.stream ? "ok" : "", S.stream ? "camera on" : "camera off");
  pill("#pTrack", S.tracking ? "ok" : S.stream ? "warn" : "", S.tracking ? `${S.arm} arm · ${S.fps} fps` : S.stream ? "arm not in view" : "no tracking");
  const b = { live: ["ok", "arm live"], sim: ["warn", "twin only"], connecting: ["warn", "connecting…"], error: ["bad", "arm error"], offline: ["bad", "bridge offline"] }[S.robot];
  pill("#pBot", ...b);
  $("#hud").innerHTML = S.stream ? `<span class="tag">${S.arm.toUpperCase()} ARM</span>` + (S.engaged ? `<span class="tag" style="color:#ff5a5a">● ENGAGED</span>` : "") : "";
}
let bannerT;
function banner(t, bad = false, ms = 1200) {
  const b = $("#banner"); b.textContent = t; b.className = "banner show" + (bad ? " bad" : "");
  clearTimeout(bannerT); bannerT = setTimeout(() => b.className = "banner", ms);
}

// ---------- bridge ----------
let ws;
function connectWS() {
  const key = new URLSearchParams(location.hash.slice(1)).get("key") || "";   // shared links carry #key=…
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws${key ? "?key=" + encodeURIComponent(key) : ""}`);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === "status") {
      Object.assign(S, { robot: m.robot, msg: m.msg, mode: m.mode, engaged: m.engaged, limits: m.limits || S.limits, calibrationId: m.calibration_id });
      pills();
      if (S.step === "robot") render(); else if (S.step === "live") liveStatus();
    } else if (m.type === "obs") S.obs = m.joints;
    else if (m.type === "selftest") { S.tests = m.results; showTests() }
    else if (m.type === "error") banner(m.msg, true, 4000);
  };
  ws.onclose = () => {
    Object.assign(S, { robot: "offline", engaged: false, msg: "The bridge isn't running. On the robot's laptop run: python bridge.py" });
    pills(); if (S.step === "robot") render(); else if (S.step === "live") liveStatus();
    setTimeout(connectWS, 1500);
  };
}
const send = m => ws?.readyState === 1 && ws.send(JSON.stringify(m));

// ---------- wizard ----------
const fig = (e, w, h) => {
  const sx = 95, sy = 60, k = 0.6, E = [sx + e[0] * k, sy + e[1] * k], W = [sx + w[0] * k, sy + w[1] * k];
  const Hd = h ? [sx + h[0] * k, sy + h[1] * k] : null;
  const flip = S.arm === "left" ? 'transform="translate(150 0) scale(-1 1)"' : "";
  return `<svg viewBox="0 0 150 170"><g ${flip} fill="none" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="75" cy="30" r="13" stroke="#8a8d94" stroke-width="4"/>
    <path d="M75 46V110M55 60H95M55 60L50 102L48 138M75 110L62 160M75 110L88 160" stroke="#4a4e57" stroke-width="5"/>
    <path d="M${sx} ${sy}L${E}L${W}${Hd ? "L" + Hd : ""}" stroke="#c8ff3d" stroke-width="7" style="filter:drop-shadow(0 0 6px #c8ff3d88)"/>
    <circle cx="${W[0]}" cy="${W[1]}" r="5" fill="#c8ff3d"/></g></svg>`;
};
const STEPS = [
  { id: "match", t: "Match the reference pose", d: "Upper arm out, elbow bent, forearm up. Keep your fingers open like the reference photo. The robot should already be in its matching pose.", fig: () => fig([60, 0], [60, -60], [80, -60]), cap: ["lift", "elbow", "pan", "wrist", "roll", "grip"] },
  { id: "pinch", t: "Close your fingers", d: "Pinch thumb and index finger together. Only your hand is being measured; the robot stays still.", emoji: "🤏", cap: ["grip"], ok: f => f.grip < S.draft.humanZero.grip - 0.08 || "Pinch tighter" },
];

let hold = 0, lastTick = 0, samples = [], capturing = false;
function go(step) { S.step = step; hold = 0; samples = []; render() }

function stepTick(now) {
  const dt = Math.min(100, now - (lastTick || now)); lastTick = now;
  if (S.step === "camera") return camChecks();
  const st = STEPS.find(s => s.id === S.step);
  if (!st || capturing) return;
  const raw = S.raw?.f;
  let hint = "";
  if (!raw) { hint = "Show both shoulders, your elbow, wrist and hand."; hold = 0; samples = [] }
  else if (st.cap.some(k => !Number.isFinite(raw[k]))) { hint = "Keep your upper arm out from your body and your hand visible."; hold = 0; samples = [] }
  else {
    samples.push({ t: now, f: raw }); samples = samples.filter(s => now - s.t < 600);
    const stable = st.cap.every(k => {
      const v = samples.map(s => s.f[k]);
      if (v.length < 5) return false;
      return (circular(k) ? Math.max(...v.map(x => Math.abs(wrap(x - v[0])))) * 2 : Math.max(...v) - Math.min(...v)) < TOL[k];
    });
    const ok = st.ok ? st.ok(raw) : true;
    if (ok !== true) { hint = ok; hold = 0 }
    else if (!stable) { hint = "Hold still…"; hold = Math.max(0, hold - dt * 2) }
    else { hint = "Hold this pose…"; hold += dt }
  }
  const ring = $("#ring"), h = $("#hint");
  if (ring) { ring.style.setProperty("--p", Math.min(1, hold / HOLD)); ring.firstElementChild.textContent = hold > 0 ? `${Math.round(Math.min(1, hold / HOLD) * 100)}%` : "hold" }
  if (h) h.textContent = hint;
  if (hold >= HOLD) capture(st);
}

async function api(command) {
  const key = new URLSearchParams(location.hash.slice(1)).get("key");
  const response = await fetch(`/api/${command}`, { method: "POST", headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function capture(st) {
  capturing = true;
  try {
    if (st.id === "match") {
      const humanZero = Object.fromEntries(st.cap.map(k => {
        const values = samples.map(s => s.f[k]);
        const base = values[0];
        return [k, circular(k) ? wrap(base + median(values.map(v => wrap(v - base)))) : median(values)];
      }));
      const physical = S.robot === "live";
      const state = physical ? await api("reference") : { joints: SIM_POSE, calibration_id: null };
      // A slow response or a changed pose cannot silently become a match.
      const current = S.raw?.f;
      if (S.step !== "match" || !current || performance.now() - S.lastSeen > 150 || st.cap.some(k => !Number.isFinite(current[k]) || Math.abs(circular(k) ? wrap(current[k] - humanZero[k]) : current[k] - humanZero[k]) > TOL[k])) {
        throw new Error("Pose changed during capture. Hold the reference pose again.");
      }
      S.draft = { version: 1, physical, humanZero, robotZero: state.joints, calibrationId: state.calibration_id, arm: S.arm, cameraId: S.cameraId };
      banner(physical ? "Matching pose captured" : "Preview pose captured");
      go("pinch");
    } else {
      const calib = { ...S.draft, pinch: median(samples.map(s => s.f.grip)) };
      if (!validReference(calib)) throw new Error("Open your fingers more in the reference pose, then try again.");
      S.calib = calib; S.target = { ...calib.robotZero };
      save("matchedPose-v1", calib);
      banner("Angles matched · 1° follows 1°");
      go("live");
    }
  } catch (e) {
    banner(e.message, true, 4000); hold = 0; samples = [];
  } finally { capturing = false }
}

function matchProblem() {
  if (!validReference(S.calib)) return "Capture a matching pose first";
  if (!S.calib.physical) return "This is a preview match. Capture a new match with the robot connected";
  if (S.calib.arm !== S.arm || S.calib.cameraId !== S.cameraId) return "Camera or arm changed. Capture a new match";
  if (S.calib.calibrationId !== S.calibrationId) return "Robot calibration changed. Capture a new match";
  return "";
}

function camChecks() {
  const r = S.raw, set = (id, on) => $(id)?.classList.toggle("on", !!on);
  const L = r?.L, [s, e, w] = IDX[S.arm];
  set("#cS", L && L[s].visibility > 0.6); set("#cE", L && L[e].visibility > 0.6);
  set("#cW", L && L[w].visibility > 0.6); set("#cH", r?.H);
  const b = $("#next"); if (b) b.disabled = !(r && r.H && r.vis > 0.6);
}

function render() {
  const s = S.step, i = STEPS.findIndex(x => x.id === s);
  if (s === "intro") {
    panel.innerHTML = `
      <div class="kicker">SO-101 · camera teleop</div>
      <h1>Move your arm.<br>The robot moves with you.</h1>
      <p class="lead">Match one pose with the robot. From there, each degree you move changes its matching joint by one degree, within the arm's limits.</p>
      <div class="row"><button class="btn" id="go">Turn on camera →</button>${S.calib ? `<button class="btn ghost" id="skip">Use my last match</button>` : ""}</div>
      <p class="small">Video never leaves this device. Only joint angles go to the robot.</p>`;
    $("#go").onclick = async () => { try { await startCamera(); go("camera") } catch (e) { banner("Camera blocked: " + e.message, true, 4000) } };
    if ($("#skip")) $("#skip").onclick = async () => { try { await startCamera(); go(S.calib ? "live" : "camera") } catch (e) { banner("Camera blocked: " + e.message, true, 4000) } };
  } else if (s === "camera") {
    panel.innerHTML = `
      <div class="kicker">Step 1 of 3 · Camera</div>
      <h2>Get your arm in the frame</h2>
      <p class="lead">Keep both shoulders and your controlling elbow, wrist and hand in view. Keep the camera in the same position after matching.</p>
      <select id="cams"></select>
      <div class="row"><span class="small grow">Which arm is the controller?</span>
        <div class="seg"><button data-a="left" class="${S.arm === "left" ? "on" : ""}">Left</button><button data-a="right" class="${S.arm === "right" ? "on" : ""}">Right</button></div></div>
      <div class="checks">
        <div class="check" id="cS"><i>✓</i>Shoulder</div><div class="check" id="cE"><i>✓</i>Elbow</div>
        <div class="check" id="cW"><i>✓</i>Wrist</div><div class="check" id="cH"><i>✓</i>Hand</div></div>
      <button class="btn" id="next" disabled>Set up the robot →</button>`;
    navigator.mediaDevices.enumerateDevices().then(ds => {
      const cur = S.stream?.getVideoTracks()[0]?.getSettings().deviceId;
      $("#cams").innerHTML = ds.filter(d => d.kind === "videoinput").map((d, n) => `<option value="${d.deviceId}" ${d.deviceId === cur ? "selected" : ""}>${d.label || "Camera " + (n + 1)}</option>`).join("");
    });
    $("#cams").onchange = e => startCamera(e.target.value);
    panel.querySelectorAll(".seg button").forEach(b => b.onclick = () => { S.arm = b.dataset.a; save("arm", S.arm); S.calib = null; S.fs = null; S.raw = null; render(); pills() });
    $("#next").onclick = () => { S.draft = {}; S.calib = null; go("robot") };
  } else if (i >= 0) {
    const st = STEPS[i];
    panel.innerHTML = `
      <div class="kicker">Step 3 of 3 · Match ${i + 1}/${STEPS.length}</div>
      <div class="dots">${STEPS.map((_, k) => `<span class="${k < i ? "done" : k === i ? "cur" : ""}"></span>`).join("")}</div>
      <div class="pose"><div class="fig">${st.emoji || st.fig()}</div>
        <div><h2>${st.t}</h2><p class="lead" style="margin-top:8px">${st.d}</p></div></div>
      <div class="row"><div class="ring" id="ring"><span>hold</span></div>
        <div class="grow"><div class="hint" id="hint"></div><p class="small">Hold the pose still. It captures on its own.</p></div></div>
      <div class="row"><button class="btn ghost" id="back">← Back</button></div>`;
    $("#back").onclick = () => go(i ? STEPS[i - 1].id : "robot");
  } else if (s === "robot") {
    const icon = { live: "🦾", sim: "🧊", connecting: "⏳", error: "⚠️", offline: "🔌" }[S.robot];
    panel.innerHTML = `
      <div class="kicker">Step 2 of 3 · Robot</div>
      <h2>Set the matching robot pose</h2>
      <div class="robotcard"><div class="big">${icon}</div><div><b>${{ live: "Arm connected", sim: "No arm yet", connecting: "Connecting…", error: "Arm problem", offline: "Bridge offline" }[S.robot]}</b><div class="small">${S.msg}</div></div></div>
      <div class="row">
        ${S.robot === "live" ? `<button class="btn ghost" id="poseArm" ${!["idle", "limp"].includes(S.mode) ? "disabled" : ""}>${S.mode === "limp" ? "Lock arm in this pose" : "Pose by hand"}</button><button class="btn" id="live" ${S.mode !== "idle" ? "disabled" : ""}>Match my arm →</button>` : `<button class="btn" id="conn" ${S.robot === "offline" || S.robot === "connecting" ? "disabled" : ""}>Connect arm</button><button class="btn ghost" id="live">Preview without the robot</button>`}
      </div>
      <p class="lead">First link upright, next link reaching out, gripper facing forward and open, like the reference photo. Support the arm while posing it, then lock it before matching.</p>
      <p class="small">Matching reads the robot's current angles. Preview matches cannot drive a connected robot.</p>`;
    if ($("#conn")) $("#conn").onclick = () => send({ type: "connect" });
    if ($("#poseArm")) $("#poseArm").onclick = () => send({ type: "limp", on: S.mode !== "limp" });
    $("#live").onclick = () => go("match");
  } else if (s === "live") {
    panel.innerHTML = `
      <div class="row"><div class="kicker grow">Live control</div><span class="small" id="lstat"></span></div>
      <div id="twin"><span class="tag" id="twinLabel">arm preview</span></div>
      <p class="small">Matched angles · 1° follows 1°. Stop before reversing a joint with ⇄. Wrist angles are camera estimates.</p>
      <div class="joints">${JOINTS.map(j => `<div class="joint"><span>${LABEL[j]}</span><div class="bar"><s id="a_${j}"></s><b id="t_${j}"></b></div><span id="v_${j}">–</span><button class="flip ${S.flip[j] ? "on" : ""}" data-j="${j}" title="Reverse this joint">⇄</button></div>`).join("")}</div>
      <button class="btn engage" id="eng"></button>
      <div class="row tools"><button class="btn ghost" id="home">⌂ Ready pose</button><button class="btn ghost" id="test">Test all joints</button><button class="btn ghost" id="limp">Pose by hand</button><button class="btn" id="saveReady" hidden>Save as ready</button></div>
      <div class="tests" id="tests"></div>
      <div class="row"><button class="btn ghost" id="resync">Match again</button>${S.robot !== "live" ? `<button class="btn ghost" id="conn">Connect arm</button>` : ""}<span class="small grow" style="text-align:right"><kbd>space</kbd> engage · lime = target, blue = measured</span></div>`;
    panel.querySelectorAll(".flip").forEach(b => b.onclick = () => { if (S.engaged) return; S.flip[b.dataset.j] = !S.flip[b.dataset.j]; save("matchedFlip-v1", S.flip); b.classList.toggle("on") });
    $("#eng").onclick = toggleEngage;
    $("#resync").onclick = () => { send({ type: "engage", on: false }); S.draft = {}; go("camera") };
    if ($("#conn")) $("#conn").onclick = () => send({ type: "connect" });
    $("#home").onclick = () => send({ type: "home" });
    $("#test").onclick = () => { S.tests = []; showTests(); send({ type: "selftest" }) };
    $("#limp").onclick = () => send({ type: "limp", on: S.mode !== "limp" });
    $("#saveReady").onclick = () => send({ type: "save_ready" });
    makeTwin($("#twin"));
    showTests();
    liveStatus();
  }
}

function toggleEngage() {
  if (S.robot !== "live") return banner("Connect the arm first. The twin already follows you.", true, 2000);
  if (!S.engaged && BUSY[S.mode]) return banner(BUSY[S.mode], true, 2000);
  if (!S.engaged && matchProblem()) return banner(matchProblem(), true, 4000);
  if (!S.engaged && (!S.raw || performance.now() - S.lastSeen > 150)) return banner("Get your arm and hand in view first", true);
  if (!S.engaged) send({ type: "target", joints: S.target });
  send({ type: "engage", on: !S.engaged });
}
addEventListener("keydown", e => { if (e.code === "Space" && S.step === "live") { e.preventDefault(); toggleEngage() } });

function liveStatus() {
  const b = $("#eng"); if (!b) return;
  const live = S.robot === "live", busy = BUSY[S.mode];
  b.className = "btn engage" + (S.engaged ? " on" : "");
  b.textContent = !live ? "Twin only · connect the arm to engage" : S.engaged ? "■ Stop · robot is copying you" : busy || "▶ Engage robot";
  b.disabled = !live || !!busy;
  const lock = !live || S.engaged;
  $("#home").disabled = lock || S.mode === "limp";
  $("#test").disabled = lock || S.mode !== "idle";
  $("#limp").disabled = lock || !["idle", "limp"].includes(S.mode);
  $("#limp").textContent = S.mode === "limp" ? "🔒 Lock arm" : "✋ Pose by hand";
  $("#saveReady").hidden = S.mode !== "limp";
  $("#lstat").textContent = S.msg;
  panel.querySelectorAll(".flip").forEach(b => b.disabled = S.engaged);
  pills();
}

const BUSY = { homing: "Moving to the ready pose…", testing: "Self-test running…", limp: "Arm is limp · lock it first" };

function showTests() {
  const el = $("#tests"); if (!el) return;
  el.innerHTML = (S.tests || []).map(r => {
    const u = r.joint === "gripper" ? "" : "°", f = v => (v > 0 ? "+" : "") + v + u;
    return `<div class="test ${r.ok ? "ok" : "bad"}"><b>${r.ok ? "✓" : "✗"}</b>${LABEL[r.joint]}<span>${f(r.moved)} of ${f(r.want)}</span></div>`;
  }).join("");
}

function liveBars() {
  for (const j of JOINTS) {
    const [lo, hi] = S.limits[j] || (j === "gripper" ? [0, 100] : [-90, 90]);
    const pos = v => `${clamp((v - lo) / (hi - lo), 0, 1) * 100}%`;
    const t = S.target[j], a = S.obs[j];
    const tb = $("#t_" + j); if (!tb) return;
    if (t !== undefined) { tb.style.left = pos(t); $("#v_" + j).textContent = t.toFixed(0) + (j === "gripper" ? "%" : "°") }
    if (a !== undefined) $("#a_" + j).style.left = pos(a);
  }
}

// ---------- digital twin ----------
let twinStop;
function makeTwin(el) {
  twinStop?.();
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  r.setPixelRatio(devicePixelRatio); el.appendChild(r.domElement);
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(38, 1, 0.01, 10);
  cam.position.set(0.45, 0.38, 0.55);
  const ctl = new OrbitControls(cam, r.domElement); ctl.target.set(0, 0.16, 0); ctl.enableDamping = true; ctl.enablePan = false;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x1a2230, 1.5));
  const dl = new THREE.DirectionalLight(0xffffff, 2.4); dl.position.set(1, 2, 1.2); scene.add(dl);
  scene.add(new THREE.GridHelper(1.2, 24, 0x2a2f37, 0x181b20));
  const body = new THREE.MeshStandardMaterial({ color: 0xeceae4, roughness: 0.45 });
  const acc = new THREE.MeshStandardMaterial({ color: 0xc8ff3d, roughness: 0.4, emissive: 0x263400 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.6 });
  const mesh = (g, m, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); return o };
  const box = (w, h, d, m, y) => mesh(new THREE.BoxGeometry(w, h, d), m, 0, y);
  const cyl = (rr, h, m, y = 0) => mesh(new THREE.CylinderGeometry(rr, rr, h, 32), m, 0, y);
  const knuckle = () => { const k = cyl(0.021, 0.045, acc); k.rotation.z = Math.PI / 2; return k };
  const joint = (parent, y) => { const g = new THREE.Group(); g.position.y = y; parent.add(g); return g };
  scene.add(cyl(0.06, 0.03, dark, 0.015));
  const pan = joint(scene, 0.03); pan.add(cyl(0.042, 0.05, body, 0.025));
  const sh = joint(pan, 0.06); sh.add(knuckle(), box(0.036, 0.115, 0.03, body, 0.0575));
  const el2 = joint(sh, 0.115); el2.add(knuckle(), box(0.03, 0.13, 0.028, body, 0.065));
  const wf = joint(el2, 0.13); wf.add(knuckle());
  const wr = joint(wf, 0); wr.add(box(0.032, 0.05, 0.032, acc, 0.025));
  const fixed = box(0.009, 0.065, 0.022, dark, 0.08); fixed.position.x = -0.012; wr.add(fixed);
  const jaw = joint(wr, 0.05); jaw.position.x = 0.012; jaw.add(box(0.009, 0.065, 0.022, dark, 0.032));
  const cur = {};
  let raf;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const w = el.clientWidth, h = el.clientHeight;
    if (r.domElement.width !== Math.round(w * devicePixelRatio)) { r.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix() }
    const measured = S.robot === "live" && S.obs.shoulder_pan !== undefined;
    const src = measured ? S.obs : S.target;
    $("#twinLabel").textContent = measured ? "measured robot angles" : "target preview";
    for (const j of JOINTS) { const t = src[j] ?? 0; cur[j] = (cur[j] ?? t) + 0.25 * (t - (cur[j] ?? t)) }
    pan.rotation.y = rad(cur.shoulder_pan);
    sh.rotation.x = rad(cur.shoulder_lift);
    el2.rotation.x = rad(cur.elbow_flex) + Math.PI / 2;
    wf.rotation.x = rad(cur.wrist_flex);
    wr.rotation.y = rad(cur.wrist_roll);
    jaw.rotation.z = -rad((cur.gripper ?? 0) * 0.4);
    ctl.update(); r.render(scene, cam);
  };
  tick();
  twinStop = () => { cancelAnimationFrame(raf); r.dispose() };
}

connectWS();
render();
pills();
