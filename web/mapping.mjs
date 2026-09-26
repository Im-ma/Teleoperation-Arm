// A photographed pose defines correspondence, not servo encoder zero.
// Capture both poses together, then apply degree changes about that reference.
export const JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"];
export const FEATURES = { shoulder_pan: "pan", shoulder_lift: "lift", elbow_flex: "elbow", wrist_flex: "wrist", wrist_roll: "roll" };
// From the URDF at the stretched start pose: +lift, +elbow and +wrist_flex all move the gripper DOWN,
// while the human angles are + when the arm/hand goes UP. The elbow keeps +1 because the robot's elbow
// sits at its end stop when stretched and can only fold one way (down): a bend maps to a bend.
export const DEFAULT_SIGN = { shoulder_pan: 1, shoulder_lift: -1, elbow_flex: 1, wrist_flex: -1, wrist_roll: 1 };
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const wrap = d => ((d + 180) % 360 + 360) % 360 - 180;
export const circular = k => ["pan", "wrist", "roll"].includes(k);
const finite = Number.isFinite;
const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const length = a => Math.hypot(...a);
const angle = (a, b) => Math.acos(clamp(dot(a, b) / (length(a) * length(b)), -1, 1)) * 180 / Math.PI;

export function armAngles(world) {
  const [s, e, w] = [12, 14, 16];
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
  return c?.version === 1 && c.arm === "right"
    && [true, false].includes(c.physical)
    && Object.values(FEATURES).every(k => finite(c.humanZero?.[k]))
    && finite(c.humanZero?.grip)
    && JOINTS.every(j => finite(c.robotZero?.[j]))
    && finite(c.pinch) && c.humanZero.grip - c.pinch > 0.08;
}

// Exact SO-101 kinematics, fitted from the URDF (error < 0.001°). Elevations are degrees above
// horizontal, pointing forward, in the arm's vertical plane:
//   upper link = 76.03 − shoulder_lift
//   forearm    = upper − 73.82 − elbow_flex
//   tool       = forearm − 5.05 − wrist_flex
// The human features use the same convention (upper arm = lift, forearm = lift + elbow,
// hand = lift + elbow + wrist), so each robot link copies the matching human segment:
export const KIN = { lift: 76.03, elbow: -73.82, wrist: -5.05 };
export function kinematicJoints(f, flip = {}) {
  const out = {};
  if (finite(f?.lift)) out.shoulder_lift = KIN.lift - f.lift;
  // The robot's forearm can only fold one way (at most 23° past straight), so a bend in either
  // direction folds it by the same amount. Flip the elbow for exact signed geometry instead.
  if (finite(f?.elbow)) out.elbow_flex = KIN.elbow + (flip.elbow_flex ? -f.elbow : Math.abs(f.elbow));
  if (finite(f?.wrist)) out.wrist_flex = KIN.wrist - (flip.wrist_flex ? -1 : 1) * wrap(f.wrist);
  return out;
}

// Hand-position mirroring (inverse kinematics). The robot's wrist pivot goes to the same place, relative to
// its shoulder, as your wrist relative to your shoulder (scaled by reach), and the claw points where your
// hand points. The elbow always bends the robot's natural way (elbow above the shoulder-wrist line), so a
// raised hand raises the claw however your own elbow bends: nothing can run the opposite way.
// Link lengths (m) from the URDF, in the arm's vertical plane.
export const LINK = { upper: 0.116, fore: 0.135 };
const R2D = 180 / Math.PI, D2R = Math.PI / 180;
export function reachJoints(f, limits = {}) {
  if (!finite(f?.reachAng) || !finite(f?.reach)) return null;
  const { upper: a, fore: b } = LINK, lim = j => limits[j]?.every(finite) ? limits[j] : [-180, 180];
  const [liftLo, liftHi] = lim("shoulder_lift"), [elbLo, elbHi] = lim("elbow_flex");
  // a human arm never reads fully straight on camera: 92% of its length counts as straight
  const d = (a + b) * clamp(f.reach / 0.92, 0.25, 1), phi = f.reachAng * D2R;
  const W = [d * Math.cos(phi), d * Math.sin(phi)];
  // law of cosines: bend = angle between the upper-arm and forearm directions (0 = straight)
  let bend = Math.acos(clamp((d * d - a * a - b * b) / (2 * a * b), -1, 1));
  bend = clamp(bend, (elbLo - KIN.elbow) * D2R, (elbHi - KIN.elbow) * D2R);
  let U = phi + Math.atan2(b * Math.sin(bend), a + b * Math.cos(bend));       // upper-link elevation
  const Ulo = (KIN.lift - liftHi) * D2R, Uhi = (KIN.lift - liftLo) * D2R;
  let Fe;
  if (U < Ulo || U > Uhi) {            // shoulder at its stop: aim the forearm at the target from the elbow
    U = clamp(U, Ulo, Uhi);
    Fe = Math.atan2(W[1] - a * Math.sin(U), W[0] - a * Math.cos(U));
  } else Fe = U - bend;
  const out = { shoulder_lift: KIN.lift - U * R2D, elbow_flex: clamp((U - Fe) * R2D + KIN.elbow, elbLo, elbHi) };
  const Fdeg = U * R2D - (out.elbow_flex - KIN.elbow);
  // the claw points where your hand points (or along your forearm when the hand isn't seen)
  const handEl = finite(f.lift) && finite(f.elbow) ? f.lift + f.elbow + (finite(f.wrist) ? wrap(f.wrist) : 0) : Fdeg;
  out.wrist_flex = Fdeg + KIN.wrist - handEl;
  return out;
}

export function mapMatchedPose(features, reference, limits, flip = {}) {
  if (!validReference(reference)) return {};
  const out = {}, put = (j, v) => {
    const range = limits[j];
    if (finite(v) && range?.every(finite) && range[0] < range[1]) out[j] = clamp(v, ...range);
  };
  for (const [j, v] of Object.entries(reachJoints(features, limits) ?? kinematicJoints(features, flip))) put(j, v);
  // Base: swinging the arm toward the camera swings the robot toward the viewer of the twin.
  if (finite(features?.pan)) put("shoulder_pan", reference.robotZero.shoulder_pan + DEFAULT_SIGN.shoulder_pan * (flip.shoulder_pan ? -1 : 1) * wrap(features.pan));
  if (finite(features?.roll)) put("wrist_roll", reference.robotZero.wrist_roll + DEFAULT_SIGN.wrist_roll * (flip.wrist_roll ? -1 : 1) * wrap(features.roll - reference.humanZero.roll));
  if (finite(features?.grip)) {
    // A fist or pinch (thumb tip to index tip under a quarter hand length) closes the jaw fully and a
    // relaxed open hand opens it fully, across the gripper's whole range.
    const openRef = clamp(reference.humanZero.grip, 0.6, 0.9);
    const open = clamp((features.grip - reference.pinch) / (openRef - reference.pinch), 0, 1);
    const [lo, hi] = limits.gripper?.every(finite) ? limits.gripper : [0, 100];
    put("gripper", flip.gripper ? hi - open * (hi - lo) : lo + open * (hi - lo));
  }
  return out;
}
