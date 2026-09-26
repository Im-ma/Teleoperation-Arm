# Human arm → SO-ARM101

This demonstration explains the six control channels in the current Marionette frontend. It uses a CAD-derived SO-101 rig and an approximate human arm rig. The 54-second film presents individual channels, simultaneous views, and an orbit around synchronized movement. It is an **illustrative animation**, not a recording of tracked human motion or verified physical robot behavior.

## What the reference photographs establish

- [Human photograph](assets/reference/human.JPG), supplied as `IMG_1889.JPG`: the upper arm extends outward, the elbow is bent approximately a right angle, the forearm rises, and the wrist bends so the fingers extend approximately horizontally. The thumb is separated from the fingers. The shoulder is partly outside the frame.
- [Robot photograph](assets/reference/robot.JPG), supplied as `IMG_1887.JPG`: an ivory printed arm has dark servo housings, exposed fasteners and wiring, a table-clamped base, an approximately upright first long link, an approximately horizontal second long link, and an open asymmetric gripper.
- The mechanism is consistent with the SO-ARM101 identified by the repository. The two photographs establish visual reference poses; they do not establish synchronized capture, exact dimensions, camera depth, calibrated motor readings, or hidden mechanical offsets.

The human and robot long links point in different directions in these references. Matching means corresponding joints and changes from a reference pose, not making their absolute link orientations identical.

## Current control mapping

The authoritative mapping for this demonstration is [`marionette/web/mapping.mjs`](../marionette/web/mapping.mjs). Human feature extraction also uses [`marionette/web/app.js`](../marionette/web/app.js). Servo names and IDs are declared in [`so_follower.py`](../teleop_so_leader/so101_teleop/so101_teleop/robots/so_follower.py).

| Servo | Robot channel | Human feature | Default response |
|---|---|---|---|
| 1 | `shoulder_pan` | Upper-arm azimuth relative to the shoulder line | +1° per degree of feature change |
| 2 | `shoulder_lift` | Upper-arm angle from hanging down | −1° per degree of feature change |
| 3 | `elbow_flex` | Angle between upper arm and forearm; straight is 0° | +1° per degree of feature change |
| 4 | `wrist_flex` | Signed projected angle from forearm to wrist→middle-knuckle direction | +1° per degree of feature change |
| 5 | `wrist_roll` | Projected index-to-pinky knuckle-line angle relative to forearm | +1° per degree of feature change |
| 6 | `gripper` | Thumb/index-tip separation divided by wrist-to-middle-knuckle distance | Pinch closes; reopening restores the captured opening |

For the five arm channels, the mapper computes:

```text
target = clamp(robotReference + defaultSign × optionalFlip × humanFeatureChange,
               calibratedLowerLimit, calibratedUpperLimit)
```

Pan, wrist bend, and wrist roll use the shortest wrapped angular change. Each channel can be reversed. Gripper values are a normalized 0–100 range, not degrees; the default closed target is 0. Reopening reproduces the reference opening, which can be less than 100.

Pan becomes undefined near a vertical upper arm; the frontend retains its last valid target. Wrist bend and roll are camera-dependent estimates, especially when the hand is edge-on. Consequently, a visually clear animated wrist rotation does not demonstrate equivalent monocular tracking accuracy.

## Motor coordinates and CAD coordinates

LeRobot motor degrees use the midpoint of each calibrated encoder range as zero. The CAD rig instead uses the origins, fixed rotations, local axes, and joint limits in [`so101_new_calib.urdf`](assets/robot/so101_new_calib.urdf). The URDF uses radians and local joint axes; its zero pose must not be treated as the photographed robot's measured zero.

The bridge's saved-calibration soft limits observed during this audit were:

| Channel | Bridge command range |
|---|---:|
| Shoulder pan | −109.615° to +109.615° |
| Shoulder lift | −101.791° to +101.791° |
| Elbow flex | −94.099° to +94.099° |
| Wrist flex | −90.055° to +90.055° |
| Wrist roll | −147° to +147° |
| Gripper | 0–100 |

[`bridge.py`](../marionette/bridge.py) derives these limits from calibration with a 3° margin and a wrist-roll cap. These values describe the saved calibration at audit time, not a hardware certification, and can change after recalibration. CAD limits and calibrated motor limits are separate constraints. A display reference offset aligns the illustrative CAD pose; it does not calibrate the physical robot.

The CAD supplies the robot's mechanical geometry and joint hierarchy. Ivory material styling follows the photograph. The human rig is constructed for legible shoulder, elbow, wrist, and finger motion; it is not a body scan or a biomechanically validated reconstruction of the photographed person.

## Source differences and verification boundary

- The sibling `so101/web/app.js` retains the earlier nine-pose range-sync workflow. It stretches a user's range onto the robot range and differs from the current matched-pose mapper used here.
- The current Marionette frontend captures one matched pose and a pinch reference. Its physical capture calls `POST /api/reference` and expects a calibration identifier. The current bridge accepts generic command routes but has no reference-command implementation and does not supply that identifier. A successful HTTP response alone does not verify reference capture.
- The older `mimic.py` desktop path uses different gains, including disabled wrist-roll movement. It is not the mapping used by this film.
- The existing operator-page twin uses approximate boxes and an assumed elbow display offset. This demonstration uses the CAD rig independently.

The film imports the current mapping module but supplies authored motion. It is served by a standalone static server with no robot bridge, serial connection, camera capture, or hardware commands. Playback is therefore a demonstration of intended correspondence, not evidence that the full physical control path has passed validation.

Physical validation remains necessary to establish the robot's measured reference pose, CAD-to-motor offsets, direction of each axis, gripper endpoints, tracking behavior, and reachable collision-free motion. Those checks were not performed to make this film, and no hardware operation should be inferred from it.
