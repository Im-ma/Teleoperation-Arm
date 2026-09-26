// "Marionette, wave!" Hold G (or type in the box) → speech to text in the browser →
// bridge asks Gemini to pick ONE gesture from a fixed list → robot plays it at capped speed.
// Gemini never sends joint angles.
export function createCommands({ onHeard, onReply, isDriving }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, listening = false;

  async function run(text) {
    text = text.trim();
    if (!text) return;
    onHeard?.(text);
    if (isDriving()) return onReply?.({ reply: "I'm busy copying you. Step out of frame, then ask me again.", gesture: "none" });
    try {
      const r = await fetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      onReply?.(await r.json());
    } catch (e) { onReply?.({ reply: "I couldn't reach the robot.", gesture: "none" }) }
  }

  function start() {
    if (!SR || listening) return false;
    rec = new SR(); rec.lang = "en-US"; rec.interimResults = false;
    let said = "";
    rec.onresult = e => { said = [...e.results].map(r => r[0].transcript).join(" ") };
    rec.onend = () => { listening = false; run(said) };
    rec.onerror = () => { listening = false };
    rec.start(); listening = true;
    return true;
  }
  const stop = () => rec?.stop();

  return { run, start, stop, get listening() { return listening }, supported: !!SR };
}
