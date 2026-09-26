// UI only: observe the controller and delegate controls to its existing handlers.
import { getUiSnapshot } from './app.js';
import { initCameraUI } from './camera-ui.mjs';
import { estimateSyncQuality } from './ui-metrics.mjs';

const get = id => document.getElementById(id);
const trends = { sync: [], fps: [] };
const push = (name, value) => {
  trends[name].push(value);
  if (trends[name].length > 50) trends[name].shift();
};
function trend(id, values, color, ceiling) {
  const canvas = get(id), ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (values.filter(Number.isFinite).length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  let drawing = false;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) { drawing = false; return; }
    const x = index / 49 * canvas.width;
    const y = canvas.height - 4 - Math.min(1, value / ceiling) * (canvas.height - 8);
    if (drawing) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    drawing = true;
  });
  ctx.stroke();
}
function refresh() {
  const s = getUiSnapshot();
  const mirroring = s.state === 'MIRRORING';
  const stateNames = { BOOT: 'Getting ready', HOMING: 'Returning home', WAITING: 'Waiting for you', ACQUIRING: 'Matching pose', MIRRORING: 'Mirroring', HOLD: 'Holding' };
  get('uiState').textContent = stateNames[s.state] || s.state;
  get('uiGestureDetail').textContent = mirroring && Number.isFinite(s.target.gripper)
    ? `Gripper target · ${Math.round(s.target.gripper)}% open`
    : get('capText').textContent;
  get('uiTracking').textContent = get('pTrack').textContent.trim();
  get('uiCamName').textContent = s.camera.recordedVideo ? 'Recorded video' : s.camera.label || 'Camera';
  const fps = s.camera.active || s.camera.recordedVideo ? s.fps : null;
  const quality = estimateSyncQuality(s);
  get('uiFps').textContent = Number.isFinite(fps) ? Math.round(fps) : '—';
  get('uiSync').textContent = quality === null ? '—' : Math.round(quality);
  get('uiSyncStatus').textContent = quality === null ? 'Sync: waiting' : `Sync: ${Math.round(quality)}%`;
  push('sync', quality); push('fps', fps);
  trend('syncTrend', trends.sync, '#628eeb', 100);
  trend('fpsTrend', trends.fps, '#628eeb', Math.max(60, ...trends.fps.filter(Number.isFinite)));
  get('pVoice').setAttribute('aria-pressed', String(get('pVoice').textContent.trim() !== 'muted'));
}

// Reuse the original Escape/R handlers; these introduce no new robot messages.
get('uiStop').addEventListener('click', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
get('uiReset').addEventListener('click', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' })));
get('uiStop').disabled = false;
get('uiReset').disabled = false;
get('toolsLink').addEventListener('click', () => { get('debug').open = true; });
initCameraUI({ button: get('cameraSettingsButton') });
try {
  const profile = JSON.parse(localStorage.getItem('mimic.ui.profile.v1'));
  if (typeof profile?.name === 'string' && profile.name.trim()) {
    const name = profile.name.trim().slice(0, 60);
    const parts = name.split(/\s+/);
    get('uiAvatar').textContent = (parts.length > 1 ? Array.from(parts[0])[0] + Array.from(parts.at(-1))[0] : Array.from(parts[0])[0]).toLocaleUpperCase();
    get('uiAvatar').parentElement.setAttribute('aria-label', `${name} · local operator profile`);
  }
} catch { /* The controller works without browser storage. */ }
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 500);
