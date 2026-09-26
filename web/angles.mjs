// Calibration-free arm angles for the goalpost match (docs/ARCHITECTURE.md).
// Shoulder, elbow and wrist hinges are measured in the camera image, in a body
// frame built from the shoulder line: x = outward along the driving arm's side,
// y = up toward the head. Goalpost pose = lift 0, elbow 90, wrist 90.
import { wrap } from "./mapping.mjs";

const D = 180 / Math.PI;
export const SIDE = { right: [12, 14, 16, 11], left: [11, 13, 15, 12] };   // shoulder, elbow, wrist, other shoulder
export const GOALPOST = { lift: 0, elbow: 90, pan: 0 };                      // fixed human zero, no capture needed

const sub = (a, b) => a.map((v, i) => v - b[i]);
const len = a => Math.hypot(...a);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const scale = (a, k) => a.map(v => v * k);
const unit = a => scale(a, 1 / (len(a) || 1));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const v3 = p => [p.x, p.y, p.z];

export function bodyFrame(L, arm, w, h) {
  const [s, , , o] = SIDE[arm];
  const S = [L[s].x * w, L[s].y * h], O = [L[o].x * w, L[o].y * h];
  const sw = len(sub(S, O));
  if (sw < 1) return null;
  const x = scale(sub(S, O), 1 / sw), mid = scale([S[0] + O[0], S[1] + O[1]], 0.5);
  let y = [x[1], -x[0]];
  if (dot(sub([L[0].x * w, L[0].y * h], mid), y) < 0) y = scale(y, -1);   // up is where the nose is
  return { x, y, sw, S, O, mid };
}
const ang = (F, v) => Math.atan2(dot(v, F.y), dot(v, F.x)) * D;

// Base heading from MediaPipe's 3D world landmarks: 0 = arm out to the side,
// positive = swung toward the camera. Undefined when the upper arm is near vertical.
export function panAngle(W, arm) {
  const [s, e, , o] = SIDE[arm];
  if (![s, e, o].every(i => W?.[i])) return {};
  const side = [W[s].x - W[o].x, W[s].z - W[o].z], n = len(side);
  if (n < 0.08) return {};
  const [sx, sz] = scale(side, 1 / n);
  let [fx, fz] = [-sz, sx];
  if (fz > 0) [fx, fz] = [-fx, -fz];                       // forward = toward the camera (-z)
  const u = sub(v3(W[e]), v3(W[s]));
  const yaw = Math.abs(Math.atan2(sz, Math.abs(sx))) * D;
  const horiz = Math.hypot(u[0], u[2]) / (len(u) || 1);
  return { yaw, pan: horiz > 0.3 ? Math.atan2(u[0] * fx + u[2] * fz, u[0] * sx + u[2] * sz) * D : undefined };
}

// Wrist bend, roll about the hand's own axis (3D hand landmarks) and grip opening.
export function handFeatures(Hn, Hw, F, fore, w, h) {
  const P = i => [Hn[i].x * w, Hn[i].y * h];
  const hv = sub(P(9), P(0)), out = { handLen: len(hv) };
  out.wrist = wrap(ang(F, hv) - ang(F, fore));
  out.grip = len(sub(P(4), P(8))) / (out.handLen + 1e-6);
  if (Hw) {
    const a = unit(sub(v3(Hw[9]), v3(Hw[0]))), k = sub(v3(Hw[17]), v3(Hw[5]));
    const kp = sub(k, scale(a, dot(k, a)));
    const zp = unit(sub([0, 0, 1], scale(a, a[2]))), q = cross(a, zp);
    out.rollOk = Math.hypot(a[0], a[1]) > 0.5;            // hand axis not pointing at the camera
    out.roll = Math.atan2(dot(kp, zp), dot(kp, q)) * D;
  }
  return out;
}

// Everything for one arm: features, per-joint confidence (0..1) and the body frame.
// MediaPipe labels sides per frame and sometimes swaps them (profile, hips out of frame, crossed arms).
// Facing the camera your right shoulder sits on the image's left, so when 12 lands right of 11 the labels
// flipped: read the same physical arm from the other index set. Near profile the gap is ambiguous, so keep
// the last verdict until the shoulders clearly separate again.
let flipped = false;
export function physicalSide(L, arm) {
  const gap = L[11].x - L[12].x;                // > 0 when facing the camera with labels intact
  if (gap > 0.03) flipped = false; else if (gap < -0.03) flipped = true;
  return flipped ? (arm === "right" ? "left" : "right") : arm;
}

export function armFeatures(L, W, hands, arm, w, h) {
  const side = physicalSide(L, arm);
  const [s, e, wr] = SIDE[side];
  const F = bodyFrame(L, side, w, h);
  if (!F) return null;
  const P = i => [L[i].x * w, L[i].y * h], vis = i => L[i].visibility ?? 1;
  const up = sub(P(e), P(s)), fore = sub(P(wr), P(e));
  const f = {}, conf = {};
  f.lift = ang(F, up);
  f.elbow = wrap(ang(F, fore) - f.lift);
  conf.lift = len(up) > 0.2 * F.sw ? Math.min(vis(s), vis(e)) : 0;
  conf.elbow = len(fore) > 0.2 * F.sw ? Math.min(conf.lift, vis(wr)) : 0;
  const { pan, yaw } = panAngle(W, side);
  f.pan = pan; conf.pan = pan === undefined || yaw > 25 ? 0 : conf.lift;
  // the hand whose wrist sits on this arm's wrist: closer to it than to the other arm's wrist,
  // and within a third of a shoulder width (so a stray hand across the body is never taken)
  const ow = SIDE[side === "right" ? "left" : "right"][2];
  let H = null, Hw = null, best = 0.35 * F.sw;
  (hands?.landmarks || []).forEach((hl, i) => {
    const hx = hl[0].x * w, hy = hl[0].y * h;
    const d = Math.hypot(hx - L[wr].x * w, hy - L[wr].y * h), dOther = Math.hypot(hx - L[ow].x * w, hy - L[ow].y * h);
    if (d < best && d < dOther) { best = d; H = hl; Hw = hands.worldLandmarks?.[i] }
  });
  if (H) {
    const hf = handFeatures(H, Hw, F, fore, w, h);
    const ok = hf.handLen > 0.15 * F.sw ? 1 : 0;
    f.wrist = hf.wrist; conf.wrist = ok;
    f.grip = hf.grip; conf.grip = ok;
    f.roll = hf.roll; conf.roll = ok && hf.rollOk ? 1 : 0;
  }
  return { arm, f, conf, F, H, yaw: yaw ?? 0, idx: [s, e, wr] };
}

// How close to the goalpost this arm is: 1 = spot on, 0 = not at all.
export function goalpostScore(r) {
  if (!r || r.conf.elbow < 0.5) return 0;
  const { lift, elbow, pan } = r.f;
  const s = 1 - Math.max(Math.abs(lift - GOALPOST.lift) / 30, Math.abs(elbow - GOALPOST.elbow) / 45, Number.isFinite(pan) ? Math.abs(pan) / 60 : 0);
  return Math.max(0, s);
}

// Is the whole goalpost (arm out, forearm up, a bit of head room) in the picture?
// hint: null when fine, else back | closer | left | right | face | arm.
// "left/right" are the person's own left/right (they face the camera).
export function framing(r, w, h) {
  if (!r) return { ok: false, hint: "arm", meter: 0 };
  const { F } = r, sw = F.sw;
  const pts = [
    F.O.map((v, i) => v - F.x[i] * 0.35 * sw),
    F.S.map((v, i) => v + F.x[i] * 1.25 * sw + F.y[i] * 1.45 * sw),
    F.S.map((v, i) => v + F.x[i] * 1.25 * sw),
    F.S.map((v, i) => v - F.y[i] * 0.4 * sw),
  ];
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const m = 0.02 * w, bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
  const meter = Math.max(bw / (w - 2 * m), bh / (h - 2 * m));   // 1 = fills the frame
  let hint = null;
  if (meter > 1) hint = "back";
  else if (meter < 0.45) hint = "closer";
  else if (Math.min(...xs) < m) hint = "left";              // cut at the image's left edge (their right side): step to their left
  else if (Math.max(...xs) > w - m) hint = "right";
  else if (Math.min(...ys) < m) hint = "back";
  else if (r.yaw > 25) hint = "face";
  return { ok: !hint, hint, meter, box: [Math.min(...xs), Math.min(...ys), bw, bh] };
}
