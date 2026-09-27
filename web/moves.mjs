// Movement filmstrip for the vision model. It films each arm movement from where it started to where it
// stopped: the start frame is already in hand (one is kept while you're still), frames are grabbed while you
// move, and once the arm has held still for STILL_MS the end frame closes it. Each frame is cropped to the
// person alone (no background, nobody else) with their skeleton drawn in, and FRAMES of them, start to end,
// become one small numbered strip: one image, quick to send and quick for the model to read.
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [15, 19], [16, 20], [11, 23], [12, 24]];

export function createMoves({ video, onMove, STILL_MS = 400, MOVE = 0.15, EVERY_MS = 150, FRAMES = 4, SIZE = 224 }) {
  let start = null, shots = [], anchor = null, still = 0, lastShot = 0;
  function snap(L, idx, now) {
    const pts = [0, 11, 12, 13, 14, 15, 16, 19, 20].map(i => L[i]).filter(p => p && (p.visibility ?? 1) > 0.3);
    const vw = video.videoWidth, vh = video.videoHeight;
    let x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x)), y0 = Math.min(...pts.map(p => p.y)), y1 = Math.max(...pts.map(p => p.y));
    const side = Math.max((x1 - x0) * vw, (y1 - y0) * vh) * 1.3, cx = (x0 + x1) / 2 * vw, cy = (y0 + y1) / 2 * vh;
    const sx = cx - side / 2, sy = cy - side / 2, c = new OffscreenCanvas(SIZE, SIZE), g = c.getContext("2d");
    g.fillStyle = "#000"; g.fillRect(0, 0, SIZE, SIZE);
    g.drawImage(video, sx, sy, side, side, 0, 0, SIZE, SIZE);
    const P = i => [(L[i].x * vw - sx) / side * SIZE, (L[i].y * vh - sy) / side * SIZE];
    g.lineWidth = 3; g.lineCap = "round";
    for (const [a, b] of BONES) {
      g.strokeStyle = idx.includes(a) && idx.includes(b) ? "#ff3b30" : "#34c759";   // the tracked arm in red
      g.beginPath(); g.moveTo(...P(a)); g.lineTo(...P(b)); g.stroke();
    }
    lastShot = now;
    return { c, t: now };
  }
  function strip(frames) {
    const pick = frames.length <= FRAMES ? frames : Array.from({ length: FRAMES }, (_, i) => frames[Math.round(i * (frames.length - 1) / (FRAMES - 1))]);
    const c = document.createElement("canvas"); c.width = SIZE * pick.length; c.height = SIZE;
    const g = c.getContext("2d");
    pick.forEach((f, i) => {
      g.drawImage(f.c, i * SIZE, 0);
      g.fillStyle = "#fff"; g.font = "bold 20px system-ui"; g.fillText(String(i + 1), i * SIZE + 8, 26);
    });
    return c.toDataURL("image/jpeg", 0.75);
  }
  return {
    reset() { start = null; shots = []; anchor = null },
    // L: pose landmarks (normalized), idx: the tracked arm's [shoulder, elbow, wrist] indices
    update(L, idx, now) {
      if (!L || !idx) return;
      const [s, e, w] = idx, sw = Math.hypot(L[11].x - L[12].x, L[11].y - L[12].y) || 1;
      const here = [L[e], L[w]].map(p => [p.x, p.y]);
      const far = anchor && Math.max(...here.map((p, i) => Math.hypot(p[0] - anchor[i][0], p[1] - anchor[i][1]))) / sw > MOVE;
      if (!anchor || far) {
        if (far && !shots.length && start) shots.push(start);                                  // a move begins
        anchor = here; still = now;
      }
      if (now - lastShot < EVERY_MS) return;
      if (!shots.length) { start = snap(L, idx, now); return }                                // still: keep the start fresh
      if (now - still < STILL_MS) { shots.push(snap(L, idx, now)); return }                    // moving: film it
      shots.push(snap(L, idx, now));                                                            // stopped: the end
      onMove({ image: strip(shots), ms: Math.round(shots.at(-1).t - shots[0].t), frames: shots.length });
      start = shots.at(-1); shots = [];
    },
  };
}
