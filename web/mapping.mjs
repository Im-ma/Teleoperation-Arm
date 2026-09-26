// A photographed pose defines correspondence, not servo encoder zero.
// Capture both poses together, then apply degree changes about that reference.
export const JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"];
export const FEATURES = { shoulder_pan: "pan", shoulder_lift: "lift", elbow_flex: "elbow", wrist_flex: "wrist", wrist_roll: "roll" };
export const DEFAULT_SIGN = { shoulder_pan: 1, shoulder_lift: 1, elbow_flex: 1, wrist_flex: 1, wrist_roll: 1 };   // verified live on the real arm
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const wrap = d => ((d + 180) % 360 + 360) % 360 - 180;
export const circular = k => ["pan", "wrist", "roll"].includes(k);
const finite = Number.isFinite;
const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const length = a => Math.hypot(...a);
const angle = (a, b) => Math.acos(clamp(dot(a, b) / (length(a) * length(b)), -1, 1)) * 180 / Math.PI;

export function armAngles(world, arm) {
  const [s, e, w] = arm === "left" ? [11, 13, 15] : [12, 14, 16];
  if (![s, e, w, 11, 12].every(i => world?.[i] && ["x", "y", "z"].every(k => finite(world[i][k])))) return null;
  const upper = sub(world[e], world[s]), fore = sub(world[w], world[e]);
  if (length(upper) < 0.03 || length(fore) < 0.03) return null;
  const f = { lift: angle(upper, [0, 1, 0]), elbow: angle(upper, fore) };
  // Body-relative azimuth in degrees. Using the upper arm keeps elbow bends
  // from steering the base, unlike the old wrist-x / shoulder-width ratio.
  const across = sub(world[12], world[11]);
  const width = Math.hypot(across[0], across[2]);
  if (width > 0.08 && Math.hypot(upper[0], upper[2]) / length(upper) > 0.2) {
    const side = [across[0] / width, 0, across[2] / width];
    const forward = [side[2], 0, -side[0]];
    f.pan = Math.atan2(dot(upper, side), dot(upper, forward)) * 180 / Math.PI;
  } // At vertical, azimuth is undefined. Retain the last valid base target.
  return f;
}

export function validReference(c) {
  return c?.version === 1 && ["left", "right"].includes(c.arm)
    && [true, false].includes(c.physical)
    && Object.values(FEATURES).every(k => finite(c.humanZero?.[k]))
    && finite(c.humanZero?.grip)
    && JOINTS.every(j => finite(c.robotZero?.[j]))
    && finite(c.pinch) && c.humanZero.grip - c.pinch > 0.08;
}

export function mapMatchedPose(features, reference, limits, flip = {}) {
  if (!validReference(reference)) return {};
  const out = {};
  for (const [joint, feature] of Object.entries(FEATURES)) {
    if (!finite(features?.[feature])) continue;
    const range = limits[joint];
    if (!range || !range.every(finite) || range[0] >= range[1]) continue;
    let delta = features[feature] - reference.humanZero[feature];
    if (circular(feature)) delta = wrap(delta);
    const direction = DEFAULT_SIGN[joint] * (flip[joint] ? -1 : 1);
    out[joint] = clamp(reference.robotZero[joint] + direction * delta, ...range);
  }
  if (finite(features?.grip)) {
    const open = clamp((features.grip - reference.pinch) / (reference.humanZero.grip - reference.pinch), 0, 1);
    const closed = flip.gripper ? 100 : 0;
    // Reopening reproduces the photographed jaw opening, even if it was partial.
    out.gripper = clamp(closed + open * (reference.robotZero.gripper - closed), 0, 100);
  }
  return out;
}

// Simple sync: the robot's links copy the on-screen angles of your upper arm, forearm and hand.
// Offsets measured from the SO-101 CAD seen side-on: upper link = lift + 104°,
// forearm = upper + 74° + elbow, tool = forearm − 12° + wrist. No wrap, so the arm
// never flips through a limit; out-of-reach poses just rest on the nearest stop.
export function syncPose(f, limits) {
  const out = {}, put = (j, v) => { if (Number.isFinite(v)) { const [lo, hi] = limits[j] ?? [-180, 180]; out[j] = clamp(v, lo, hi) } };
  put("shoulder_lift", f.lift - 104);
  put("elbow_flex", f.elbow - 74);
  put("wrist_flex", f.wrist + 12);
  put("shoulder_pan", 0);
  put("wrist_roll", 0);
  return out;
}
