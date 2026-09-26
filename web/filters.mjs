// One Euro filter (Casiez et al., CHI 2012): smooth when still, quick when moving.
// Angles are unwrapped first so ±180 never causes a jump.
import { wrap } from "./mapping.mjs";

const alpha = (cut, dt) => 1 / (1 + 1 / (2 * Math.PI * cut * dt));

export class OneEuro {
  constructor(minCut = 1, beta = 0.02, dCut = 1) { Object.assign(this, { minCut, beta, dCut }); this.reset() }
  reset() { this.x = this.dx = this.t = undefined }
  filter(x, t) {
    if (this.t === undefined) { this.x = x; this.dx = 0; this.t = t; return x }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    this.dx += alpha(this.dCut, dt) * ((x - this.x) / dt - this.dx);
    this.x += alpha(this.minCut + this.beta * Math.abs(this.dx), dt) * (x - this.x);
    return this.x;
  }
}

// Per-feature settings: [minCutoff Hz, beta, dead zone, is an angle]
const CFG = {
  // Heavier smoothing plus a small dead zone: camera jitter of a degree or two never reaches the robot.
  lift: [0.4, 0.01, 2, true], elbow: [0.4, 0.01, 2, true], wrist: [0.4, 0.01, 3, true],
  roll: [0.6, 0.01, 3, true], pan: [0.3, 0.005, 8, true], grip: [1.5, 0.3, 0, false],
  reachAng: [0.4, 0.01, 2, true], reach: [0.5, 0.3, 0.02, false],
};
const JUMP = 30;          // degrees in one frame = a tracking glitch, not a real move: hold until it persists 0.2 s
const MIN_CONF = 0.6;

// Filters every feature and holds any joint whose confidence is low, so one bad
// landmark freezes that joint instead of stopping the whole arm.
export class FeatureFilter {
  constructor() { this.f = {}; this.raw = {}; this.out = {}; this.held = {} }
  reset() { this.f = {}; this.raw = {}; this.out = {}; this.held = {}; this.buf = [] }
  update(feat, conf, t) {
    for (const [k, [mc, beta, dead, isAngle]] of Object.entries(CFG)) {
      let x = feat[k];
      const good = Number.isFinite(x) && (conf[k] ?? 0) >= MIN_CONF;
      if (good && isAngle && this.raw[k] !== undefined) {
        const d = wrap(x - this.raw[k].x);
        if (Math.abs(d) > JUMP && t - this.raw[k].t < 0.2) { this.held[k] = true; continue }
        x = this.raw[k].u + d;                              // unwrapped
      }
      if (!good) { this.held[k] = true; continue }
      if (k === "grip") {   // median of the last 5 readings: one misread frame can't flick the claw
        const b = (this.buf ??= []); b.push(x); if (b.length > 5) b.shift();
        x = [...b].sort((p, q) => p - q)[b.length >> 1];
      }
      this.raw[k] = { x: feat[k], u: x, t };
      const y = (this.f[k] ??= new OneEuro(mc, beta)).filter(x, t);
      const o = this.out[k];   // dead zone with hysteresis: small wobble never reaches the robot, big moves pass smoothly
      this.out[k] = !dead || o === undefined ? y : Math.abs(y - o) > dead ? y - Math.sign(y - o) * dead : o;
      this.held[k] = false;
    }
    return this.out;
  }
}
