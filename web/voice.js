// Voice coach. Lines are ElevenLabs clips cached by the bridge (/api/tts);
// without a key it falls back to the browser's own speech. Every line is also a caption.
export const LINES = {
  hello: "Hi! Copy my pose to take control. Arm out, forearm up.",
  strike: "Strike the goalpost. Arm out to the side, forearm up.",
  locked: "Got you. I'm your arm now.",
  lost: "I lost you. Paused. Put your hand back where my hand is to carry on.",
  welcome: "Welcome back.",
  bye: "Heading home. Strike the pose any time.",
  closer: "Come a little closer.",
  back: "Take a step back so I can see your whole arm.",
  left: "Step a little to your left.",
  right: "Step a little to your right.",
  face: "Turn to face the camera.",
  arm: "Show me your arm and your hand.",
  estop: "Stopping.",
  robot: "The robot stopped. Paused. Line your hand up with the robot's hand to try again.",
  realign: "Paused. Move your hand onto the robot's hand to carry on.",
};
const PRIORITY = { estop: 3, lost: 3, robot: 3, locked: 2, welcome: 2, bye: 2 };
const GAP = 2500, SAME = 8000, MAX_REPEATS = 2;

export function createVoice({ onCaption }) {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const clips = {}, lastSaid = {}, repeats = {};
  let muted = false, busyUntil = 0, source = null;

  const fetchClip = async body => {
    const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status !== 200) return null;
    return ac.decodeAudioData(await r.arrayBuffer());
  };
  const preload = () => Promise.all(Object.entries(LINES).map(async ([key, text]) => {
    try { clips[key] = await fetchClip({ key, text }) } catch { clips[key] = null }
  }));

  function speak(text, buf) {
    onCaption?.(text);
    if (muted) return;
    source?.stop?.(); speechSynthesis.cancel();
    if (buf && ac.state === "running") {
      source = ac.createBufferSource(); source.buffer = buf; source.connect(ac.destination); source.start();
      busyUntil = performance.now() + buf.duration * 1000;
    } else {
      const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; speechSynthesis.speak(u);
      busyUntil = performance.now() + text.length * 60;
    }
  }

  return {
    preload,
    get unlocked() { return ac.state === "running" },
    unlock: () => ac.resume(),
    set muted(m) { muted = m; if (m) { source?.stop?.(); speechSynthesis.cancel() } },
    get muted() { return muted },
    newPerson() { for (const k in repeats) delete repeats[k] },
    // a coaching line, with cooldowns so it never nags
    say(key) {
      if (!key || !LINES[key]) return;
      const now = performance.now(), pr = PRIORITY[key] || 1;
      if (pr < 2 && (now < busyUntil + GAP || now - (lastSaid[key] || -1e9) < SAME)) return;
      if (pr < 3 && now - (lastSaid[key] || -1e9) < 1500) return;
      lastSaid[key] = now;
      repeats[key] = (repeats[key] || 0) + 1;
      if (pr < 2 && repeats[key] > MAX_REPEATS) return onCaption?.(LINES[key]);   // caption only
      speak(LINES[key], clips[key]);
    },
    // a free-form line (Gemini replies): live TTS, fallback to browser speech
    async free(text) {
      let buf = null;
      try { buf = await fetchClip({ text }) } catch {}
      speak(text, buf);
    },
  };
}
