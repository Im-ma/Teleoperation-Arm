import * as THREE from 'three';

// A compact anatomical study, built in metres. The arm runs along each bone's
// local +X axis; every pivot stays at the anatomical joint centre.
const DEG = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;

function anatomicalLoft(profiles, material, radialSegments = 40, slices = 70) {
  const positions = [], indices = [], uvs = [];
  const start = profiles[0][0], end = profiles.at(-1)[0];
  for (let i = 0; i <= slices; i++) {
    const x = start + (end - start) * i / slices;
    let k = 0;
    while (k < profiles.length - 2 && profiles[k + 1][0] < x) k++;
    const a = profiles[k], b = profiles[k + 1];
    let f = (x - a[0]) / (b[0] - a[0]);
    f = f * f * (3 - 2 * f);
    const ry = THREE.MathUtils.lerp(a[1], b[1], f);
    const rz = THREE.MathUtils.lerp(a[2], b[2], f);
    const cy = THREE.MathUtils.lerp(a[3] || 0, b[3] || 0, f);
    const cz = THREE.MathUtils.lerp(a[4] || 0, b[4] || 0, f);
    for (let j = 0; j <= radialSegments; j++) {
      const angle = j / radialSegments * Math.PI * 2;
      positions.push(x, cy + ry * Math.cos(angle), cz + rz * Math.sin(angle));
      uvs.push(i / slices, j / radialSegments);
      if (i < slices && j < radialSegments) {
        const n = i * (radialSegments + 1) + j;
        indices.push(n, n + 1, n + radialSegments + 1);
        indices.push(n + 1, n + radialSegments + 2, n + radialSegments + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // UVs need duplicated vertices at the wrap, but skin needs one continuous
  // surface normal there. Otherwise the directional light exposes a seam.
  const normals = geometry.getAttribute('normal');
  const seamNormal = new THREE.Vector3();
  for (let i = 0; i <= slices; i++) {
    const first = i * (radialSegments + 1);
    const last = first + radialSegments;
    seamNormal.set(
      normals.getX(first) + normals.getX(last),
      normals.getY(first) + normals.getY(last),
      normals.getZ(first) + normals.getZ(last),
    ).normalize();
    normals.setXYZ(first, seamNormal.x, seamNormal.y, seamNormal.z);
    normals.setXYZ(last, seamNormal.x, seamNormal.y, seamNormal.z);
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function ellipsoid(parent, material, position, scale) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), material);
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function skinTexture() {
  const side = 128, pixels = new Uint8Array(side * side);
  let seed = 3917;
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    pixels[i] = 112 + Math.floor((seed / 4294967296) * 30);
  }
  const texture = new THREE.DataTexture(pixels, side, side, THREE.RedFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(8, 4);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function fingerSegment(length, radius, skin, nailMaterial, terminal) {
  const group = new THREE.Group();
  group.add(anatomicalLoft([
    [-radius * 0.8, 0.0002, 0.0002],
    [-radius * 0.3, radius * 0.9, radius * 0.96],
    [length * 0.10, radius, radius],
    [length * 0.48, radius * 0.90, radius * 0.92],
    [length * 0.83, radius * 0.81, radius * 0.86],
    [length + radius * 0.38, terminal ? radius * 0.45 : radius * 0.65, radius * 0.65],
    [length + radius * 0.68, 0.0002, 0.0002],
  ], skin, 24, 32));
  if (terminal) {
    const nail = ellipsoid(group, nailMaterial,
      [length * 0.64, radius * 0.80, 0],
      [length * 0.34, radius * 0.10, radius * 0.62]);
    nail.rotation.z = -4 * DEG;
  }
  return group;
}

function createFinger(parent, origin, lengths, radius, skin, nail, spread = 0) {
  const joints = [];
  let previous = parent;
  for (let i = 0; i < 3; i++) {
    const node = new THREE.Group();
    if (i === 0) node.position.set(...origin);
    else node.position.x = lengths[i - 1];
    node.rotation.y = i === 0 ? spread * DEG : 0;
    node.add(fingerSegment(lengths[i], radius * (1 - i * 0.13), skin, nail, i === 2));
    previous.add(node);
    joints.push(node);
    previous = node;
  }
  const tip = new THREE.Object3D();
  tip.position.x = lengths[2];
  previous.add(tip);
  return { joints, tip, lengths };
}

export function createHuman() {
  const root = new THREE.Group();
  root.name = 'Anatomical human controller';
  const skin = new THREE.MeshPhysicalMaterial({
    color: '#78462f', roughness: 0.52, metalness: 0,
    clearcoat: 0.035, clearcoatRoughness: 0.7,
    bumpMap: skinTexture(), bumpScale: 0.000045,
  });
  const palmSkin = skin.clone();
  palmSkin.color.set('#a86d4d');
  palmSkin.roughness = 0.6;
  const nail = new THREE.MeshPhysicalMaterial({
    color: '#b98c77', roughness: 0.4, metalness: 0,
    clearcoat: 0.14, clearcoatRoughness: 0.35,
  });

  const shoulder = new THREE.Group();
  shoulder.name = 'Human shoulder / base yaw';
  shoulder.position.y = 0.18;
  root.add(shoulder);
  const upper = new THREE.Group();
  upper.name = 'Human upper arm / shoulder elevation';
  shoulder.add(upper);
  upper.add(anatomicalLoft([
    [-0.046, 0.0003, 0.0003], [-0.034, 0.025, 0.025],
    [-0.008, 0.034, 0.032], [0.026, 0.035, 0.032],
    [0.067, 0.038, 0.033, 0.004], [0.112, 0.033, 0.027, 0.002],
    [0.154, 0.025, 0.022], [0.183, 0.024, 0.022],
    [0.204, 0.006, 0.009], [0.209, 0.0003, 0.0003],
  ], skin));

  const elbow = new THREE.Group();
  elbow.name = 'Human elbow flexion';
  elbow.position.x = 0.19;
  upper.add(elbow);
  elbow.add(anatomicalLoft([
    [-0.027, 0.0003, 0.0003], [-0.018, 0.019, 0.021],
    [0.001, 0.025, 0.025], [0.038, 0.030, 0.027, 0.001],
    [0.076, 0.027, 0.024], [0.122, 0.022, 0.020],
    [0.165, 0.016, 0.017], [0.188, 0.014, 0.017],
    [0.201, 0.007, 0.01], [0.207, 0.0003, 0.0003],
  ], skin));

  const wrist = new THREE.Group();
  wrist.name = 'Human wrist flexion';
  wrist.position.x = 0.19;
  elbow.add(wrist);
  const roll = new THREE.Group();
  roll.name = 'Human forearm / palm rotation';
  wrist.add(roll);
  // The broad dorsal palm and the warmer volar pad intersect smoothly.
  roll.add(anatomicalLoft([
    [-0.013, 0.0003, 0.0003], [-0.006, 0.0135, 0.017],
    [0.006, 0.013, 0.020], [0.025, 0.0127, 0.027],
    [0.044, 0.011, 0.030], [0.053, 0.009, 0.028],
    [0.060, 0.006, 0.023], [0.066, 0.0003, 0.0003],
  ], skin, 48, 60));
  ellipsoid(roll, palmSkin, [0.027, -0.0103, 0.001], [0.027, 0.003, 0.024]);
  ellipsoid(roll, skin, [0.010, -0.005, -0.017], [0.024, 0.014, 0.014]);

  const fingers = [
    createFinger(roll, [0.050, 0.001, -0.019], [0.025, 0.023, 0.017], 0.0078, skin, nail, 1),
    createFinger(roll, [0.057, 0.001, -0.0045], [0.030, 0.024, 0.018], 0.0080, skin, nail, 0),
    createFinger(roll, [0.053, 0.000, 0.0105], [0.027, 0.023, 0.017], 0.0075, skin, nail, -2),
    createFinger(roll, [0.043, -0.001, 0.024], [0.022, 0.017, 0.015], 0.0062, skin, nail, -5),
  ];

  const thumbBase = new THREE.Group();
  thumbBase.position.set(0.013, -0.005, -0.022);
  // Thumb abduction emerges from the radial side and opposes the index.
  thumbBase.rotation.z = -53 * DEG;
  thumbBase.rotation.y = 4 * DEG;
  roll.add(thumbBase);
  thumbBase.add(fingerSegment(0.027, 0.0105, skin, nail, false));
  const thumbMiddle = new THREE.Group();
  thumbMiddle.position.x = 0.027;
  thumbMiddle.rotation.z = 39 * DEG;
  thumbMiddle.rotation.y = -11 * DEG;
  thumbBase.add(thumbMiddle);
  thumbMiddle.add(fingerSegment(0.026, 0.0089, skin, nail, false));
  const thumbEnd = new THREE.Group();
  thumbEnd.position.x = 0.026;
  thumbEnd.rotation.z = 18 * DEG;
  thumbEnd.rotation.y = -3 * DEG;
  thumbMiddle.add(thumbEnd);
  thumbEnd.add(fingerSegment(0.018, 0.0080, skin, nail, true));
  const thumbTip = new THREE.Object3D();
  thumbTip.position.x = 0.018;
  thumbEnd.add(thumbTip);

  const hand = new THREE.Object3D();
  hand.position.set(0.033, 0, 0);
  roll.add(hand);
  const gripper = new THREE.Object3D();
  gripper.position.set(0.094, -0.025, -0.013);
  roll.add(gripper);

  const tracking = new THREE.Group();
  tracking.name = 'Human optical joint landmarks';
  const dotMaterial = new THREE.MeshStandardMaterial({
    color: '#73f5d1', emissive: '#43bca5', emissiveIntensity: 0.7,
    roughness: 0.28, metalness: 0.1,
  });
  // Small surface beads read as tracking references without replacing anatomy.
  for (const [node, z] of [[upper, 0.034], [elbow, 0.028], [wrist, 0.020]]) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0033, 16, 12), dotMaterial);
    dot.position.z = z;
    node.add(dot);
  }
  root.add(tracking);

  function setPose(pose = {}) {
    shoulder.rotation.y = (pose.pan ?? 0) * DEG;
    upper.rotation.z = ((pose.lift ?? 90) - 90) * DEG;
    elbow.rotation.z = (pose.elbow ?? 90) * DEG;
    wrist.rotation.z = (pose.wrist ?? -75) * DEG;
    roll.rotation.x = (pose.roll ?? 0) * DEG;
    const opening = clamp(pose.grip ?? 1, 0, 1);
    const closing = 1 - opening;

    // Index and thumb converge to a gentle pinch. The other fingers retain a
    // softer curl so the gesture remains readable in silhouette from all views.
    const restAngles = [[-2, -6, -4], [-5, -9, -5], [-7, -12, -7], [-9, -15, -9]];
    const closedAngles = [[-14, -62, -26], [-26, -77, -34], [-31, -84, -39], [-36, -91, -43]];
    for (let f = 0; f < fingers.length; f++) {
      for (let j = 0; j < 3; j++) {
        fingers[f].joints[j].rotation.z = THREE.MathUtils.lerp(restAngles[f][j], closedAngles[f][j], closing) * DEG;
      }
    }
    thumbBase.rotation.z = THREE.MathUtils.lerp(-65, -54, closing) * DEG;
    thumbMiddle.rotation.z = THREE.MathUtils.lerp(25, 31, closing) * DEG;
    thumbEnd.rotation.z = THREE.MathUtils.lerp(20, 17, closing) * DEG;
    root.updateMatrixWorld(true);
    // A moving landmark at the centre of the thumb/index aperture.
    const tipA = fingers[0].tip.getWorldPosition(new THREE.Vector3());
    const tipB = thumbTip.getWorldPosition(new THREE.Vector3());
    gripper.position.copy(roll.worldToLocal(tipA.add(tipB).multiplyScalar(0.5)));
    root.updateMatrixWorld(true);
  }
  setPose();
  return {
    root, setPose,
    markers: { shoulder, elbow, wrist, roll, gripper, hand, indexTip: fingers[0].tip, thumbTip },
  };
}
