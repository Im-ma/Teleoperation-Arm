const JOINTS = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'];

// Display-only estimate: average normalized joint agreement, not a sensor confidence score.
export function estimateSyncQuality(snapshot) {
  if (snapshot.robot !== 'live' || snapshot.state !== 'MIRRORING' || !snapshot.engaged) return null;
  const errors = [];
  for (const joint of JOINTS) {
    const target = snapshot.target?.[joint], measured = snapshot.obs?.[joint];
    const [low, high] = snapshot.limits?.[joint] || [];
    if (![target, measured, low, high].every(Number.isFinite) || high <= low) return null;
    errors.push(Math.min(1, Math.abs(target - measured) / (high - low)));
  }
  return 100 * (1 - errors.reduce((sum, error) => sum + error, 0) / errors.length);
}
