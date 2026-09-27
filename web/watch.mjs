// AI mode's eyes, with no body tracker: the camera view is sent to the model as it is, and movement is
// found by comparing each frame with the one before (a small grey copy, pixels that changed a lot).
// While you move nothing is asked; once the picture has held still for STILL_MS the first and last
// frames of the movement go to the model together.
export function createWatch({ video, onFrame, onMove, LIVE_MS = 1000, STILL_MS = 500, EVERY_MS = 100, SIZE = 640, CHANGED = 12 }) {
  let sg = null, prev = null, moving = false, still = 0, lastLive = 0, lastLook = 0, start = null, t0 = 0;
  const grab = () => {
    const c = new OffscreenCanvas(SIZE, Math.round(SIZE * video.videoHeight / video.videoWidth));
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    return c;
  };
  return {
    get moving() { return moving },
    reset() { prev = null; moving = false; start = null },
    update(now) {
      if (!video.videoWidth) return;
      if (now - lastLive >= LIVE_MS) { lastLive = now; const c = grab(); if (!moving) start = c; onFrame?.(c) }
      if (now - lastLook < EVERY_MS) return;
      lastLook = now;
      sg ??= new OffscreenCanvas(160, 90).getContext("2d", { willReadFrequently: true });
      sg.drawImage(video, 0, 0, 160, 90);
      const px = sg.getImageData(0, 0, 160, 90).data, grey = new Uint8Array(160 * 90);
      for (let i = 0; i < grey.length; i++) grey[i] = (px[4 * i] + 2 * px[4 * i + 1] + px[4 * i + 2]) >> 2;
      let changed = 0;
      if (prev) for (let i = 0; i < grey.length; i++) if (Math.abs(grey[i] - prev[i]) > 24) changed++;
      prev = grey;
      if (changed > CHANGED) { if (!moving) { moving = true; t0 = now; start ??= grab() } still = now }
      else if (moving && now - still >= STILL_MS) {
        moving = false;
        const end = grab();
        onMove({ start, end, ms: Math.round(still - t0) });
        start = end;
      }
    },
  };
}
