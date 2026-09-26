# Mimic UI refresh

Branch: `codex/ui-refresh`. Base: `633afd82e24d8156b3f29baeb97a6c257a3b1134`.

Implements the supplied Mimic dashboard and eight screenshot annotations:

- Live dashboard uses the existing camera canvas, tracking and SO-101 model.
- Camera source opens a settings dialog with available video inputs and actual capture settings. Source changes are allowed after camera startup while tracking is idle; active/engaged changes are rejected.
- Existing robot connection status remains live.
- Sync quality is a display-only estimate of target/measured joint agreement, normalized by calibrated joint ranges. It is unavailable unless all six measurements exist during engaged mirroring. Latency is unavailable because the bridge does not report it.
- Replay shows existing session history and target/measured charts.
- Profile stores an optional display name in this browser only. No account/backend was added.
- Existing commands and robot tools remain available.

The original `app.js` code is preserved as an exact prefix. An appended UI adapter supplies detached snapshots and guarded camera selection. All other original JS modules, Python backend, mapping, state machine, model and calibration files are unchanged. Replay's original inline module is unchanged. New navigation retains the existing authentication fragment on local page links.

The screenshot's pause/emergency wording does not match existing control behavior. The UI therefore offers **Reset control** and **Stop control** via the existing R/Escape handlers; stopping releases control and returns home. No new pause or hardware emergency-stop behavior was introduced.

Validation:

```sh
node tests/ui-regression.mjs
python3 tests/preview-ui.py
```

The preview at http://127.0.0.1:8767 has no robot bridge and explicitly denies camera/microphone capture. `--sample-history --port 8768` uses labeled synthetic replay fixtures for layout checks only. Desktop and 390px mobile layouts, camera dialog, tools navigation, profile save/reset and six replay charts were checked in-browser. Physical camera switching and real-robot operation were not acceptance-tested.

Nothing has been merged into main. Merge remains pending the user's confirmation and integration against any concurrent robot work.
