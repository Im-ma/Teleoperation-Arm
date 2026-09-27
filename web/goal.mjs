// Goal mode: the robot doesn't trace your path, only where you end up. While your arm moves the robot
// waits; once it has held still for STILL_MS that end pose becomes the goal and the robot glides there
// in one smooth move (minimum-jerk, every joint starting and arriving together). The claw follows live.
export const ARM = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll"];
const minJerk = s => s * s * s * (10 - 15 * s + 6 * s * s);

export function createGoal({ STILL_MS = 400, MOVE = 6, SPEED = 60, MIN_S = 0.8 } = {}) {
  let anchor = null, still = 0, settled = true, move = null, at = null;
  return {
    get moving() { return !settled },
    get gliding() { return !!move },
    // from: where the robot is now, so the first goal starts from there, not from a jump
    reset(from) { anchor = null; move = null; settled = true; at = from ? pick(from) : null },
    // pose: the mapped joints for the person right now. Returns the arm joints to send this frame.
    update(pose, now) {
      const p = pick(pose);
      at ??= p;
      if (!anchor) { anchor = p; still = now }
      if (spread(p, anchor) > MOVE) { anchor = p; still = now; settled = false }   // still moving: wait
      else if (!settled && now - still >= STILL_MS) {                               // stopped: go there
        settled = true;
        const from = move ? here(move, now) : at, T = Math.max(MIN_S, spread(p, from) / SPEED) * 1000;
        move = { from, to: p, t0: now, T };
      }
      if (move) { at = here(move, now); if (now - move.t0 >= move.T) move = null }
      return at;
    },
  };
}

const pick = j => Object.fromEntries(ARM.filter(k => Number.isFinite(j[k])).map(k => [k, j[k]]));
const spread = (a, b) => Math.max(0, ...ARM.filter(k => k in a && k in b).map(k => Math.abs(a[k] - b[k])));
function here(m, now) {
  const s = minJerk(Math.min(1, (now - m.t0) / m.T));
  return Object.fromEntries(Object.keys(m.to).map(k => [k, (m.from[k] ?? m.to[k]) + s * (m.to[k] - (m.from[k] ?? m.to[k]))]));
}
