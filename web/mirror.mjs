// Live-mirror state machine (docs/ARCHITECTURE.md). Pure logic: app.js gives it
// one observation per camera frame and carries out the actions it returns.
//
//   BOOT → HOMING → WAITING → ACQUIRING → MIRRORING ⇄ HOLD
//   HOLD pauses the robot where it is and never gives up: mirroring resumes once the person's hand lines
//   up with the robot's hand again (person.align reaches 1). Only Stop / Reset start over.
//
// observation: { now, robotReady, engaged, live, person }
//   person: { arm, core, straight, align (0..1), score, framing: {ok, hint}, id: {cx, sw} } or null
// result: { state, ring (0..1), hint, say, resume, actions: [lock | engage | disengage | send | home] }
export const T = { LOCK_MS: 500, SEEN_MS: 150, LOST_MS: 400, BACK_MS: 500, GONE_MS: 1500, HINT_MS: 700, LIVE_HINT_MS: 2500 };

export function createMirror() {
  let state = "BOOT", since = 0, last = 0, seen = 0, lock = 0, lastOk = 0, arm = null, why = "lost";
  let hint = null, hintSince = 0;


  return {
    get state() { return state }, get arm() { return arm },
    stop(now) { state = "HOMING"; since = now; lock = seen = 0; arm = null; return { actions: ["disengage", "home"], say: "estop" } },
    tick(o) {
      const { now } = o, p = o.person?.core ? o.person : null, dt = Math.min(100, now - (last || now));
      last = now;
      const out = { state, ring: 0, hint: null, say: null, actions: [] };
      const go = s => { state = out.state = s; since = now };
      seen = p ? seen + dt : 0;

      // hints must persist before they are spoken, so a flicker never talks
      const h = o.person ? o.person.framing?.hint ?? null : "arm";
      if (h !== hint) { hint = h; hintSince = now }
      const settled = ms => hint && now - hintSince > ms ? hint : null;

      switch (state) {
        case "BOOT":
          if (!since) { since = now; out.actions.push("home") }   // every page load starts from the saved start pose
          if (o.robotReady && now - since > 600) go("WAITING");
          break;
        case "HOMING":
          if (o.robotReady && now - since > 600) go("WAITING");
          break;
        case "WAITING":
          if (seen > T.SEEN_MS) { go("ACQUIRING"); out.say = "hello"; lock = 0 }
          break;
        case "ACQUIRING": {
          if (!o.person && now - since > 800 && now - lastOk > T.GONE_MS) { go("WAITING"); break }
          if (p) lastOk = now;
          const ready = !!p?.straight;   // calibrate: arm stretched straight out, like the robot's start pose
          lock = ready ? lock + dt : Math.max(0, lock - 2 * dt);
          out.ring = Math.min(1, lock / T.LOCK_MS);
          out.hint = !o.person ? "arm" : ready ? "hold" : "strike";
          out.say = null;
          if (lock >= T.LOCK_MS) {
            arm = p.arm; lastOk = now;
            out.actions.push("lock", "engage"); out.say = "locked"; lock = 0;
            go("MIRRORING");
          }
          break;
        }
        case "MIRRORING":
          if (p) { lastOk = now; out.actions.push("send") }
          out.hint = o.person?.framing.hint || null;
          out.say = settled(T.LIVE_HINT_MS);
          // lost the arm, or the bridge's own dead-man stopped us
          // (a robot stop is not "I lost you": say which it was)
          if (now - lastOk > T.LOST_MS || (o.live && !o.engaged && now - since > 1500)) {
            why = now - lastOk > T.LOST_MS ? "lost" : "robot";
            out.actions.push("disengage"); out.say = why; lock = 0; go("HOLD");
          }
          break;
        case "HOLD":
          // paused where it stopped; carry on only once the hand is back on the robot's hand
          lock = p && p.align >= 1 ? lock + dt : 0;
          out.ring = p ? Math.max(p.align ?? 0, Math.min(1, lock / T.BACK_MS)) : 0;
          out.hint = why === "robot" ? "robot" : p ? "realign" : "lost";
          if (lock >= T.BACK_MS) { lock = 0; out.actions.push("engage"); out.resume = true; out.say = "welcome"; lastOk = now; go("MIRRORING") }
          break;
      }
      out.state = state;
      return out;
    },
  };
}
