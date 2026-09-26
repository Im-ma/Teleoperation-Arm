/**
 * Offline UI compatibility checks. Run: node tests/ui-regression.mjs
 * No server, socket, camera, microphone, model or robot is accessed: browser
 * dependencies are stubbed; the original and refreshed controllers run in VMs.
 * The baseline is pinned so committing the refresh cannot weaken these checks.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import vm from 'node:vm';
import * as mapping from '../web/mapping.mjs';
import * as angles from '../web/angles.mjs';
import { FeatureFilter } from '../web/filters.mjs';
import { createMirror } from '../web/mirror.mjs';
import { estimateSyncQuality } from '../web/ui-metrics.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const BASE = 'bf38745';   // robot code the UI is integrated against (IK mirroring + accuracy)
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const original = path => git('show', `${BASE}:${path}`);
const current = path => readFileSync(resolve(root, path));
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const plain = value => JSON.parse(JSON.stringify(value));
const tags = html => [...html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid=["']([^"']+)["'][^>]*)>/gi)]
  .map(([, tag, attrs, id]) => ({ id, tag: tag.toLowerCase(), attrs }));
const modules = html => [...html.matchAll(/<script\b(?=[^>]*\btype=["']module["'])(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);

test('all baseline robot, bridge, mapping, model and support files are byte-identical', () => {
  const allowed = new Set(['web/index.html', 'web/replay.html', 'web/app.js']);
  const files = git('ls-tree', '-r', '--name-only', BASE).toString().trim().split('\n');
  for (const file of files.filter(file => !allowed.has(file))) {
    assert.ok(existsSync(resolve(root, file)), `Protected file removed: ${file}`);
    assert.ok(current(file).equals(original(file)), `Protected file changed: ${file}`);
  }
});

test('original controller is an exact prefix; replay execution code is unchanged', () => {
  assert.ok(current('web/app.js').subarray(0, original('web/app.js').length).equals(original('web/app.js')),
    'The original controller must remain unchanged; adapters may only be appended');
  assert.deepEqual(modules(current('web/replay.html').toString()), modules(original('web/replay.html').toString()));
});

test('live and history retain unique original DOM IDs and element types', () => {
  for (const path of ['web/index.html', 'web/replay.html']) {
    const before = tags(original(path).toString());
    const after = tags(current(path).toString());
    assert.equal(new Set(after.map(el => el.id)).size, after.length, `Duplicate IDs in ${path}`);
    for (const el of before) assert.equal(after.find(next => next.id === el.id)?.tag, el.tag, `${path}: #${el.id} changed or missing`);
  }
  const html = current('web/index.html').toString();
  assert.match(html, /<video\b[^>]*\bid="video"[^>]*\bplaysinline\b[^>]*\bmuted\b/);
  assert.match(html, /<script\b[^>]*\btype="module"[^>]*\bsrc="\/web\/app\.js"/);
});

function makeHarness(source) {
  const logs = { sent: [], voice: [], commands: [], timers: [], media: [], sockets: [] };
  const listeners = new Map();
  const elements = new Map();
  const context2d = new Proxy({}, { get: (target, key) => target[key] ?? (() => {}), set: (target, key, value) => (target[key] = value, true) });
  class Element {
    constructor(id = '') {
      this.id = id; this.style = {}; this.dataset = {}; this.children = []; this.attributes = {};
      this.textContent = ''; this.innerHTML = ''; this.value = ''; this.hidden = false; this.disabled = false;
      this.open = false; this.width = 1280; this.height = 720; this.clientWidth = 600; this.clientHeight = 400;
      this.readyState = 0; this.paused = true; this.currentTime = 0; this.videoWidth = 1280; this.videoHeight = 720;
      this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
      this.handlers = new Map();
    }
    get lastElementChild() { return this.lastChild ??= new Element(); }
    get childElementCount() { return this.children.length; }
    get options() { return this.children; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    getContext() { return context2d; }
    querySelector(selector) { return element(`${this.id} ${selector}`); }
    querySelectorAll() { return []; }
    addEventListener(name, fn) { const list = this.handlers.get(name) ?? []; list.push(fn); this.handlers.set(name, list); }
    removeEventListener(name, fn) { this.handlers.set(name, (this.handlers.get(name) ?? []).filter(item => item !== fn)); }
    dispatchEvent(event) { for (const fn of this.handlers.get(event.type) ?? []) fn(event); return true; }
    click() { if (this.disabled) return; this.onclick?.({ target: this }); this.dispatchEvent({ type: 'click', target: this }); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    removeAttribute(name) { delete this.attributes[name]; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatchEvent({ type: 'close' }); }
  }
  const element = selector => {
    const id = selector.replace(/^#/, '');
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const addListener = (name, fn) => { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list); };
  const dispatch = event => { for (const fn of listeners.get(event.type) ?? []) fn(event); return true; };
  class BasicThree {
    constructor() { this.position = { set() {} }; this.target = { set() {} }; this.domElement = new Element(); }
    add() {} addEventListener() {} setPixelRatio() {} setSize() {} updateProjectionMatrix() {} update() {} render() {}
  }
  class Socket {
    constructor(url) { this.url = url; this.readyState = 1; logs.sockets.push(this); }
    send(data) { logs.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const voice = { muted: false, unlocked: false, preload() {}, unlock() { this.unlocked = true; return Promise.resolve(); },
    say(value) { logs.voice.push(value); }, free(value) { logs.voice.push(value); }, newPerson() {} };
  const store = new Map();
  const document = { querySelector: element, getElementById: element, querySelectorAll: () => [],
    createElement: () => new Element(), body: new Element(), hidden: false, addEventListener: addListener,
    removeEventListener() {}, dispatchEvent: dispatch };
  const sandbox = { console, URLSearchParams, Date, Math, Promise, Error, Object, Number,
    ...mapping, ...angles, FeatureFilter, createMirror, document,
    location: { search: '', hash: '', protocol: 'http:', host: 'offline.invalid' },
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    navigator: { permissions: { query: async () => ({ state: 'prompt' }) }, mediaDevices: {
      getUserMedia: async constraints => { logs.media.push(constraints); throw new Error('Camera intentionally unavailable in offline test'); },
      enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {},
    } },
    WebSocket: Socket, THREE: Object.fromEntries(['WebGLRenderer', 'Scene', 'PerspectiveCamera', 'HemisphereLight', 'DirectionalLight', 'GridHelper'].map(name => [name, BasicThree])),
    OrbitControls: BasicThree, createRobot: async () => ({ root: {}, setPose() {} }),
    createVoice: () => voice, LINES: { lost: 'Lost tracking' },
    createCommands: () => ({ run: text => logs.commands.push(['run', text]), start: () => (logs.commands.push(['start']), true), stop: () => logs.commands.push(['stop']) }),
    FilesetResolver: { forVisionTasks: async () => { throw new Error('No model access allowed'); } }, PoseLandmarker: {}, HandLandmarker: {},
    performance: { now: () => 1000 }, devicePixelRatio: 1,
    requestAnimationFrame() {}, cancelAnimationFrame() {},
    setTimeout: (fn, delay) => (logs.timers.push({ fn, delay }), logs.timers.length), clearTimeout() {},
    setInterval: (fn, delay) => (logs.timers.push({ fn, delay, interval: true }), logs.timers.length), clearInterval() {},
    addEventListener: addListener, removeEventListener() {}, dispatchEvent: dispatch,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } },
    KeyboardEvent: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  // ES imports supply only inert stubs or local pure functions above. Never load a CDN.
  const executable = source.replace(/^import .*;\s*$/gm, '').replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, '');
  vm.runInContext(executable, context, { filename: 'offline-controller.js', timeout: 1000 });
  const run = expression => vm.runInContext(expression, context, { timeout: 1000 });
  const status = overrides => logs.sockets[0].onmessage({ data: JSON.stringify({ type: 'status', robot: 'live', mode: 'idle', engaged: false, msg: 'Ready', ...overrides }) });
  return { logs, sandbox, element, run, status, voice, dispatch, document, store };
}

function controllerTrace(source) {
  const h = makeHarness(source);
  assert.equal(h.logs.media.length, 0, 'Page load must not bypass the existing camera permission gate');
  assert.equal(h.logs.sent.length, 0, 'Page load must not send new robot commands');
  h.status({ limits: { shoulder_pan: [-120, 120] } });
  for (const id of ['home', 'test', 'limp']) { assert.equal(h.element(id).disabled, false); h.element(id).click(); }
  h.status({ mode: 'limp' });
  assert.equal(h.element('saveReady').hidden, false);
  assert.equal(h.element('home').disabled, true);
  h.element('limp').click(); h.element('saveReady').click();
  h.status({ mode: 'idle' });
  for (const key of ['Escape', 'r', 'R', 'm', 'M', 'g', 'G']) h.dispatch({ type: 'keydown', key });
  h.dispatch({ type: 'keyup', key: 'g' });
  h.dispatch({ type: 'keyup', key: 'G' });
  const commandCount = h.logs.sent.length;
  h.dispatch({ type: 'keydown', key: 'Escape', repeat: true });
  assert.equal(h.logs.sent.length, commandCount, 'Repeated keys must not repeat robot actions');
  h.element('cmdText').value = 'wave';
  let stopped = false;
  h.element('cmdText').onkeydown({ key: 'Enter', stopPropagation() { stopped = true; } });
  assert.ok(stopped, 'Typing commands must stay isolated from global robot shortcuts');
  assert.equal(h.element('cmdText').value, '');
  h.element('flips').onchange({ target: { dataset: { j: 'elbow_flex' }, checked: true } });
  assert.equal(h.store.get('mirrorFlip-v1'), '{"elbow_flex":true}');
  h.document.hidden = true;
  h.run('frame(1100); frame(1200)');
  assert.deepEqual(h.logs.sent.at(-1), { type: 'engage', on: false }, 'Hidden camera tab must retain disengage action');
  h.logs.sockets[0].close();
  assert.equal(h.logs.timers.at(-1).delay, 1500, 'Bridge reconnect delay must remain unchanged');
  return plain({ sent: h.logs.sent, voice: h.logs.voice, commands: h.logs.commands,
    store: [...h.store], robot: h.run('S.robot'), engaged: h.run('S.engaged'), state: h.run('M.state') });
}

test('existing keys, command input, bridge tools and hidden-tab disengage preserve their action trace', () => {
  const before = controllerTrace(original('web/app.js').toString());
  const after = controllerTrace(current('web/app.js').toString());
  assert.deepEqual(after, before);
  assert.deepEqual(before.sent.slice(0, 5), [
    { type: 'home' }, { type: 'selftest' }, { type: 'limp', on: true },
    { type: 'limp', on: false }, { type: 'save_ready' },
  ]);
  assert.deepEqual(before.sent.slice(5, 7), [{ type: 'engage', on: false }, { type: 'home' }]);
});

function fakeStream(deviceId, readyState = 'live') {
  const track = { readyState, label: deviceId, stopped: false,
    getSettings: () => ({ deviceId, width: 1280, height: 720, frameRate: 60 }),
    stop() { this.stopped = true; this.readyState = 'ended'; } };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}

function cameraHarness() {
  const h = makeHarness(current('web/app.js').toString());
  const old = fakeStream('original');
  h.sandbox.originalStream = old;
  h.run('S.stream = originalStream; video.srcObject = originalStream; $("#gate").hidden = true; M = {state: "WAITING"};');
  h.old = old;
  return h;
}

test('UI snapshots copy state and cannot mutate control targets, observations or limits', () => {
  const h = cameraHarness();
  h.run('S.obs = {shoulder_pan: 10}; S.limits = {shoulder_pan: [-120, 120]};');
  const snapshot = h.run('getUiSnapshot()');
  assert.equal(snapshot.camera.active, true);
  assert.equal(snapshot.canSwitchCamera, true);
  snapshot.target.shoulder_pan = 999;
  snapshot.obs.shoulder_pan = 999;
  snapshot.limits.shoulder_pan[0] = 999;
  snapshot.camera.settings.deviceId = 'tampered';
  const fresh = h.run('getUiSnapshot()');
  assert.equal(fresh.target.shoulder_pan, 0);
  assert.equal(fresh.obs.shoulder_pan, 10);
  assert.deepEqual(plain(fresh.limits.shoulder_pan), [-120, 120]);
  assert.equal(fresh.camera.settings.deviceId, 'original');
  assert.equal(h.logs.sent.length, 0);
});

test('camera changes reject active tracking, engagement, startup and recorded-video modes before accessing media', async () => {
  for (const expression of ['M.state = "ACQUIRING"', 'M.state = "MIRRORING"', 'M.state = "HOLD"',
    'S.engaged = true', '$("#gate").hidden = false', 'params.set("video", "/recording.mp4")', 'S.stream = null']) {
    const h = cameraHarness();
    h.run(expression);
    assert.equal(h.run('getUiSnapshot().canSwitchCamera'), false, expression);
    await assert.rejects(h.run('switchCamera("new-device")'), undefined, expression);
    assert.equal(h.logs.media.length, 0, expression);
    assert.equal(h.old.track.stopped, false, expression);
    assert.equal(h.logs.sent.length, 0, expression);
  }
  const h = cameraHarness();
  await assert.rejects(h.run('switchCamera("")'), /Choose an available camera/);
  await h.run('switchCamera("original")');
  assert.equal(h.logs.media.length, 0, 'Selecting the active camera must be a no-op');
});

test('explicit idle camera switch commits a validated stream and releases the old stream without robot commands', async () => {
  const h = cameraHarness(), candidate = fakeStream('new-device');
  h.sandbox.navigator.mediaDevices.getUserMedia = async constraints => { h.logs.media.push(constraints); return candidate; };
  const snapshot = await h.run('switchCamera("new-device")');
  assert.equal(h.run('S.stream'), candidate);
  assert.equal(h.element('video').srcObject, candidate);
  assert.equal(h.old.track.stopped, true);
  assert.equal(candidate.track.stopped, false);
  assert.equal(snapshot.camera.settings.deviceId, 'new-device');
  assert.equal(snapshot.camera.changing, false);
  assert.deepEqual(plain(h.logs.media[0]), { audio: false,
    video: { deviceId: { exact: 'new-device' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } } });
  assert.equal(h.logs.sent.length, 0);
});

test('camera permission failure or ended candidate preserves original source and clears the switch lock', async () => {
  for (const kind of ['denied', 'ended']) {
    const h = cameraHarness(), candidate = fakeStream('candidate', 'ended');
    h.sandbox.navigator.mediaDevices.getUserMedia = async () => {
      if (kind === 'denied') throw new Error('Permission denied');
      return candidate;
    };
    await assert.rejects(h.run('switchCamera("new-device")'), kind === 'denied' ? /Permission denied/ : /no active video/);
    assert.equal(h.run('S.stream'), h.old);
    assert.equal(h.element('video').srcObject, h.old);
    assert.equal(h.old.track.stopped, false);
    assert.equal(h.run('getUiSnapshot().camera.changing'), false);
    if (kind === 'ended') assert.equal(candidate.track.stopped, true);
    assert.equal(h.logs.sent.length, 0);
  }
});

test('camera switch rechecks session state after each asynchronous step and rolls back an installed candidate', async () => {
  for (const phase of ['permission', 'probe', 'video']) {
    const h = cameraHarness(), candidate = fakeStream('candidate');
    const becomeActive = () => h.run('S.engaged = true');
    h.sandbox.navigator.mediaDevices.getUserMedia = async () => { if (phase === 'permission') becomeActive(); return candidate; };
    const create = h.document.createElement;
    h.document.createElement = tag => {
      const element = create(tag);
      element.play = async () => { if (phase === 'probe') becomeActive(); };
      return element;
    };
    h.element('video').play = async () => { if (phase === 'video' && h.element('video').srcObject === candidate) becomeActive(); };
    await assert.rejects(h.run('switchCamera("candidate")'), /session became active/, phase);
    assert.equal(h.run('S.stream'), h.old, phase);
    assert.equal(h.element('video').srcObject, h.old, phase);
    assert.equal(h.old.track.stopped, false, phase);
    assert.equal(candidate.track.stopped, true, phase);
    assert.equal(h.run('getUiSnapshot().camera.changing'), false, phase);
    assert.equal(h.logs.sent.length, 0, phase);
  }
});

test('concurrent camera selection is rejected while the first selection is pending', async () => {
  const h = cameraHarness(), candidate = fakeStream('candidate');
  let resolveMedia;
  h.sandbox.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { resolveMedia = resolve; });
  const pending = h.run('switchCamera("candidate")');
  assert.equal(h.run('getUiSnapshot().camera.changing'), true);
  await assert.rejects(h.run('switchCamera("other-camera")'), /already in progress/);
  resolveMedia(candidate);
  await pending;
  assert.equal(h.run('getUiSnapshot().camera.changing'), false);
  assert.equal(h.logs.sent.length, 0);
});

test('camera settings only enumerate on open, never start media, and isolate letter keys while retaining Escape', async () => {
  const h = cameraHarness();
  let enumerations = 0;
  h.sandbox.navigator.mediaDevices.enumerateDevices = async () => {
    enumerations++;
    return [{ kind: 'videoinput', deviceId: 'original', label: 'Original camera' }, { kind: 'audioinput', deviceId: 'mic' }];
  };
  h.run(current('web/camera-ui.mjs').toString().replace(/^import .*;\s*$/gm, '').replace(/^export\s+/gm, ''));
  const cameraUI = h.run('initCameraUI({button: document.getElementById("cameraSource")})');
  assert.equal(enumerations, 0);
  await cameraUI.open();
  assert.equal(enumerations, 1);
  assert.equal(cameraUI.dialog.querySelector('select').options.length, 1);
  assert.equal(h.logs.media.length, 0);
  for (const type of ['keydown', 'keyup']) {
    let stopped = false;
    cameraUI.dialog.dispatchEvent({ type, key: 'm', stopPropagation() { stopped = true; } });
    assert.ok(stopped, `${type} typing must not trigger global robot shortcuts`);
    stopped = false;
    cameraUI.dialog.dispatchEvent({ type, key: 'Escape', stopPropagation() { stopped = true; } });
    assert.equal(stopped, false, `${type} Escape must keep the original stop behavior`);
  }
  cameraUI.dialog.close();
  assert.equal(cameraUI.dialog.open, false);
  assert.equal(h.logs.sent.length, 0);
});

test('display-only sync estimate uses measured joint error and hides incomplete, inactive or invalid telemetry', () => {
  const snapshot = {
    robot: 'live', state: 'MIRRORING', engaged: true,
    target: Object.fromEntries(mapping.JOINTS.map(joint => [joint, 0])),
    obs: Object.fromEntries(mapping.JOINTS.map(joint => [joint, 0])),
    limits: Object.fromEntries(mapping.JOINTS.map(joint => [joint, [-100, 100]])),
  };
  assert.equal(estimateSyncQuality(snapshot), 100);
  snapshot.obs = Object.fromEntries(mapping.JOINTS.map(joint => [joint, 100]));
  assert.equal(estimateSyncQuality(snapshot), 50);
  snapshot.obs = Object.fromEntries(mapping.JOINTS.map(joint => [joint, 500]));
  assert.equal(estimateSyncQuality(snapshot), 0);
  for (const override of [{ robot: 'sim' }, { robot: 'offline' }, { state: 'HOLD' }, { state: 'WAITING' },
    { engaged: false }, { obs: {} }, { target: {} }, { limits: {} },
    { obs: { ...snapshot.obs, gripper: NaN } }, { limits: { ...snapshot.limits, gripper: [10, 10] } }]) {
    assert.equal(estimateSyncQuality({ ...snapshot, ...override }), null);
  }
});

test('presentation refresh only reads telemetry; visible stop/reset buttons reuse the original Escape/R actions', () => {
  const h = cameraHarness();
  h.sandbox.estimateSyncQuality = estimateSyncQuality;
  h.run(current('web/camera-ui.mjs').toString().replace(/^import .*;\s*$/gm, '').replace(/^export\s+/gm, ''));
  h.run(current('web/ui.js').toString().replace(/^import .*;\s*$/gm, ''));
  assert.equal(h.logs.sent.length, 0, 'Initializing presentation must not emit robot commands');
  assert.equal(h.logs.media.length, 0, 'Initializing presentation must not start a camera');
  assert.equal(h.element('uiSync').textContent, '—');
  h.run(`S.robot = "live"; S.engaged = true; M = createMirror();
    M = {state: "MIRRORING", stop: M.stop}; S.fps = 48;
    S.target = Object.fromEntries(JOINTS.map(j => [j, 0]));
    S.obs = Object.fromEntries(JOINTS.map(j => [j, 50]));
    S.limits = Object.fromEntries(JOINTS.map(j => [j, [-100, 100]])); refresh();`);
  assert.equal(Number(h.element('uiFps').textContent), 48);
  assert.equal(Number(h.element('uiSync').textContent), 75);
  assert.equal(h.element('uiCamName').textContent, 'original');
  assert.equal(h.logs.sent.length, 0, 'Refreshing presentation must not emit robot commands');
  h.element('uiStop').click();
  assert.deepEqual(h.logs.sent, [{ type: 'engage', on: false }, { type: 'home' }]);
  h.element('uiReset').click();
  assert.deepEqual(h.logs.sent.slice(2), [{ type: 'engage', on: false }, { type: 'home' }]);
});

let failed = 0;
for (const { name, fn } of cases) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} offline UI regression checks passed. No hardware or network was accessed.`);
process.exitCode = failed ? 1 : 0;
