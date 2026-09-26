// Presentation-only preferences. This page does not connect to robot controls.
(() => {
  "use strict";

  const STORAGE_KEY = "mimic.ui.profile.v1";
  const form = document.querySelector("#profileForm");
  const input = document.querySelector("#profileName");
  const avatar = document.querySelector("#profileAvatar");
  const heading = document.querySelector("#profile-heading");
  const count = document.querySelector("#nameCount");
  const status = document.querySelector("#profileStatus");
  const reset = document.querySelector("#resetProfile");

  function message(text, kind = "") {
    status.textContent = text;
    status.dataset.kind = kind;
  }

  function preview() {
    const name = input.value.trim();
    const parts = name.split(/\s+/).filter(Boolean);
    const initials = parts.length
      ? [parts[0], ...(parts.length > 1 ? [parts[parts.length - 1]] : [])]
        .map(part => Array.from(part)[0]).join("").toLocaleUpperCase()
      : "OP";
    avatar.textContent = initials;
    heading.textContent = name || "Operator";
    count.textContent = `${input.value.length} / 60`;
  }

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && typeof saved.name === "string") input.value = saved.name.slice(0, 60);
    else if (saved !== null) message("The saved profile could not be read. You can save a new name.");
  } catch {
    message("Your saved profile could not be read. You can try saving a new name.");
  }

  preview();
  input.disabled = false;
  document.querySelector("#saveProfile").disabled = false;
  reset.disabled = false;

  input.addEventListener("input", () => {
    preview();
    message("Unsaved changes.");
  });

  form.addEventListener("submit", event => {
    event.preventDefault();
    const name = input.value.trim().slice(0, 60);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ name }));
      input.value = name;
      preview();
      message("Profile saved on this browser.", "success");
    } catch {
      message("This browser could not save your profile. Check that local storage is allowed and try again.", "error");
    }
  });

  reset.addEventListener("click", () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
      input.value = "";
      preview();
      message("Local profile reset. The dashboard will show Operator.", "success");
      input.focus();
    } catch {
      message("This browser could not reset your saved profile. Please try again.", "error");
    }
  });
})();
