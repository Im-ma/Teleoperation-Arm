// Live-mirror state machine (docs/ARCHITECTURE.md). Pure logic: app.js gives it
// one observation per camera frame and carries out the actions it returns.
//
//   BOOT → HOMING → WAITING → ACQUIRING → MIRRORING ⇄ HOLD → (10 s alone) HOMING
//
// observation: { now, robotReady, engaged, live, person }
//   person: { arm, core, score, framing: {ok, hint}, id: {cx, sw} } or null
// result: { state, ring (0..1), hint, say, actions: [lock | engage | disengage | send | reset | home] }
export const T = { LOCK_MS: 1, SEEN_MS: 150, LOST_MS: 400, BACK_MS: 500, SAME_MS: 3000, HOME_MS: 10000, GONE_MS: 1500, HINT_MS: 700, LIVE_HINT_MS: 2500 };

export function createMirror() {
  let state = "BOOT", since = 0, last = 0, seen = 0, lock = 0, lastOk = 0, lostAt = 0, id = null, arm = null;
  let hint = null, hintSince = 0;

  const samePerson = p => id && Math.abs(p.id.cx - id.cx) < 0.5 * id.sw && Math.abs(p.id.sw / id.sw - 1) < 0.25;

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
        case "HOMING":
          if (o.robotReady && now - since > 600) go("WAITING");
          break;
        case "WAITING":
          if (seen > T.SEEN_MS) { go("ACQUIRING"); out.say = "hello"; lock = 0 }
          break;
        case "ACQUIRING": {
          if (!o.person && now - since > 800 && now - lastOk > T.GONE_MS) { go("WAITING"); break }
          if (p) lastOk = now;
          const ready = !!p;   // no line-up: any clearly seen arm starts mirroring
          lock = ready ? lock + dt : Math.max(0, lock - 2 * dt);
          out.ring = Math.min(1, lock / T.LOCK_MS);
          out.hint = o.person ? "hold" : "arm";
          out.say = null;
          if (lock >= T.LOCK_MS) {
            id = p.id; arm = p.arm; lastOk = now;
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
          if (now - lastOk > T.LOST_MS || (o.live && !o.engaged && now - since > 1500)) {
            out.actions.push("disengage"); out.say = "lost"; lostAt = now; go("HOLD");
          }
          break;
        case "HOLD":
          out.hint = "lost";
          if (seen > T.BACK_MS) {
            if (samePerson(p) && now - lostAt < T.SAME_MS) { out.actions.push("reset", "engage"); out.say = "welcome"; lastOk = now; go("MIRRORING") }
            else { arm = null; lock = 0; out.say = "hello"; go("ACQUIRING") }
          } else if (now - lostAt > T.HOME_MS) { arm = null; out.actions.push("home"); out.say = "bye"; go("HOMING") }
          break;
      }
      out.state = state;
      return out;
    },
  };
}
