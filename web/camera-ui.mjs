import { getUiSnapshot, switchCamera } from "./app.js";

const initialized = new WeakMap();

export function initCameraUI({ button }) {
  if (!button) return null;
  if (initialized.has(button)) return initialized.get(button);

  button.setAttribute("aria-haspopup", "dialog");
  const dialog = document.createElement("dialog");
  dialog.className = "camera-dialog";
  dialog.setAttribute("aria-labelledby", "camera-dialog-title");
  dialog.setAttribute("aria-describedby", "camera-dialog-description");
  dialog.innerHTML = `
    <div class="camera-dialog-heading">
      <div><h2 id="camera-dialog-title">Camera settings</h2><p id="camera-dialog-description">Choose the camera used for live tracking.</p></div>
      <button class="camera-dialog-close" type="button" aria-label="Close camera settings">×</button>
    </div>
    <p class="camera-dialog-status" role="status" aria-live="polite"></p>
    <label class="camera-source-label" for="camera-source-select">Camera source</label>
    <select id="camera-source-select" class="camera-source-select" aria-describedby="camera-dialog-status"></select>
    <dl class="camera-details">
      <div><dt>Resolution</dt><dd class="camera-resolution">Camera not started</dd></div>
      <div><dt>Frame rate</dt><dd class="camera-frame-rate">Camera not started</dd></div>
    </dl>
    <p class="camera-dialog-error" role="alert" hidden></p>
    <div class="camera-dialog-actions">
      <button class="camera-dialog-cancel" type="button">Close</button>
      <button class="camera-dialog-apply" type="button">Apply camera</button>
    </div>`;
  document.body.appendChild(dialog);

  const select = dialog.querySelector("select");
  const status = dialog.querySelector(".camera-dialog-status");
  status.id = "camera-dialog-status";
  const error = dialog.querySelector(".camera-dialog-error");
  const apply = dialog.querySelector(".camera-dialog-apply");
  const resolution = dialog.querySelector(".camera-resolution");
  const frameRate = dialog.querySelector(".camera-frame-rate");
  let poll = null, loading = false, applying = false, completed = false, openVersion = 0;

  const showError = message => { error.textContent = message; error.hidden = !message };
  function render() {
    const snapshot = getUiSnapshot(), camera = snapshot.camera, settings = camera.settings;
    if (!camera.active) status.textContent = "Start camera to change its source.";
    else if (applying || camera.changing) status.textContent = "Checking the selected camera… Your current source stays active until it is ready.";
    else if (!snapshot.canSwitchCamera) status.textContent = ["MIRRORING", "ACQUIRING", "HOLD"].includes(snapshot.state) || snapshot.engaged
      ? "Stop the session before changing its camera source."
      : "Wait for the camera and tracker to finish starting.";
    else if (loading) status.textContent = "Looking for available cameras…";
    else if (completed) status.textContent = "Camera source updated.";
    else status.textContent = "Select an available camera. Changes apply to this session only.";
    resolution.textContent = camera.active ? (settings?.width && settings?.height ? `${settings.width} × ${settings.height}` : "Not reported by camera") : "Camera not started";
    frameRate.textContent = camera.active ? (Number.isFinite(settings?.frameRate) ? `${Math.round(settings.frameRate * 10) / 10} fps` : "Not reported by camera") : "Camera not started";
    select.disabled = loading || applying || !snapshot.canSwitchCamera || !select.options.length;
    apply.disabled = select.disabled || !select.value || select.value === settings?.deviceId;
  }

  async function open() {
    if (dialog.open) return;
    completed = false; showError(""); loading = true;
    const version = ++openVersion;
    select.replaceChildren();
    dialog.showModal(); render();
    poll = setInterval(render, 250);
    try {
      if (!navigator.mediaDevices?.enumerateDevices) throw new Error("Camera discovery is unavailable in this browser.");
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "videoinput");
      if (version !== openVersion || !dialog.open) return;
      for (const [index, device] of devices.entries()) {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || `Camera ${index + 1}`;
        select.appendChild(option);
      }
      const current = getUiSnapshot().camera.settings?.deviceId;
      if (current && devices.some(device => device.deviceId === current)) select.value = current;
      if (!devices.length) showError("No cameras were reported by this browser.");
    } catch (failure) {
      if (version === openVersion && dialog.open) showError(failure.message || "Could not list available cameras.");
    } finally {
      if (version === openVersion) { loading = false; render() }
    }
  }

  apply.addEventListener("click", async () => {
    if (apply.disabled) return;
    applying = true; completed = false; showError(""); render();
    try {
      const snapshot = await switchCamera(select.value);
      if (snapshot.camera.settings?.deviceId) select.value = snapshot.camera.settings.deviceId;
      completed = true;
    } catch (failure) { showError(failure.message || "Could not change the camera source.") }
    finally { applying = false; render() }
  });
  select.addEventListener("change", () => { completed = false; showError(""); render() });
  for (const close of dialog.querySelectorAll(".camera-dialog-close, .camera-dialog-cancel")) close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { ++openVersion; clearInterval(poll); poll = null });
  // A select's letter navigation must not trigger R/G/M shortcuts. Escape keeps
  // propagating so the existing emergency-stop shortcut remains available.
  dialog.addEventListener("keydown", event => { if (event.key !== "Escape") event.stopPropagation() });
  // A G press may have begun before the dialog opened. Always let its release
  // reach the existing hold-to-talk stop handler.
  dialog.addEventListener("keyup", event => { if (!["Escape", "g", "G"].includes(event.key)) event.stopPropagation() });
  button.addEventListener("click", open);
  const controller = { open, dialog };
  initialized.set(button, controller);
  return controller;
}
