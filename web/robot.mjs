import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

/**
 * IMG_1892 visual reference, in CAD joint degrees; not a motor calibration.
 * The lower link extends back, the next link rises, and the tool points forward.
 * Exact lower-link horizontal would need -103.96775° at shoulder_lift, outside
 * the official -100° CAD stop. Keep the real limit and its 3.96775° inclination.
 */
export const ROBOT_REFERENCE_POSE = Object.freeze({
  shoulder_pan: 0,
  shoulder_lift: -100,
  elbow_flex: 12.207492,
  wrist_flex: 87.792881,
  wrist_roll: 0,
  gripper: 24,
});

export const ROBOT_JOINT_NAMES = Object.freeze([
  'shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper',
]);

const vector = (value, fallback = [0, 0, 0]) => value
  ? value.trim().split(/\s+/).map(Number)
  : fallback;
const childElements = (node, tag) => [...node.children].filter(child => child.tagName === tag);
const firstChild = (node, tag) => childElements(node, tag)[0];

function applyOrigin(object, origin) {
  if (!origin) return;
  object.position.fromArray(vector(origin.getAttribute('xyz')));
  const [roll, pitch, yaw] = vector(origin.getAttribute('rpy'));
  // URDF fixed-axis RPY is Rz(yaw) Ry(pitch) Rx(roll), not Three's default XYZ.
  object.quaternion.setFromEuler(new THREE.Euler(roll, pitch, yaw, 'ZYX'));
}

/**
 * Load the official SO-101 CAD hierarchy. Units: metres. Outer root: Three Y-up.
 * setPose accepts partial canonical joint names. Arm values: CAD degrees.
 * gripper: 0..100% opening across the CAD lower..upper limits, not degrees.
 * No hardware, camera or control-bridge access is used by this module.
 */
export async function createRobot(options = {}) {
  const urdfURL = new URL(options.urdfURL || './robot/so101_new_calib.urdf', import.meta.url);
  const response = await fetch(urdfURL);
  if (!response.ok) throw new Error(`Robot CAD could not be loaded (${response.status}).`);
  const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('Robot CAD contains malformed XML.');
  const robotElement = xml.documentElement;
  const root = new THREE.Group();
  root.name = 'SO-101 · photo-matched ivory CAD';
  const native = new THREE.Group();
  native.name = 'URDF Z-up → scene Y-up';
  native.rotation.x = -Math.PI / 2;
  root.add(native);

  const ivory = new THREE.MeshPhysicalMaterial({
    color: options.ivoryColor || '#eee9d7',
    roughness: 0.43,
    metalness: 0.015,
    clearcoat: 0.12,
    clearcoatRoughness: 0.6,
  });
  const servo = new THREE.MeshStandardMaterial({
    color: '#171d22',
    roughness: 0.34,
    metalness: 0.17,
  });
  const links = {};
  const joints = {};
  const markers = {};
  const jointDefinitions = {};
  const childLinks = new Set();
  const loader = new STLLoader();
  const geometries = new Map();

  function loadGeometry(url) {
    if (!geometries.has(url)) geometries.set(url, loader.loadAsync(url).then(geometry => {
      // STL assets are already in metres. Preserve their CAD coordinates.
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      return geometry;
    }));
    return geometries.get(url);
  }

  const visualLoads = [];
  for (const linkElement of childElements(robotElement, 'link')) {
    const link = new THREE.Group();
    link.name = linkElement.getAttribute('name');
    links[link.name] = link;
    for (const visual of childElements(linkElement, 'visual')) {
      const meshElement = firstChild(firstChild(visual, 'geometry'), 'mesh');
      if (!meshElement) continue;
      const filename = meshElement.getAttribute('filename');
      const url = new URL(filename, urdfURL).href;
      visualLoads.push(loadGeometry(url).then(geometry => {
        const materialName = firstChild(visual, 'material')?.getAttribute('name');
        const mesh = new THREE.Mesh(geometry, materialName === 'sts3215' ? servo : ivory);
        mesh.name = filename.split('/').pop().replace('.stl', '');
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.source = filename;
        applyOrigin(mesh, firstChild(visual, 'origin'));
        if (meshElement.hasAttribute('scale')) mesh.scale.fromArray(vector(meshElement.getAttribute('scale'), [1, 1, 1]));
        link.add(mesh);
      }));
    }
  }

  for (const jointElement of childElements(robotElement, 'joint')) {
    const name = jointElement.getAttribute('name');
    const type = jointElement.getAttribute('type');
    const parentName = firstChild(jointElement, 'parent').getAttribute('link');
    const childName = firstChild(jointElement, 'child').getAttribute('link');
    if (!links[parentName] || !links[childName]) throw new Error(`Missing CAD link for ${name}.`);
    childLinks.add(childName);

    const origin = new THREE.Group();
    origin.name = `${name} · fixed origin`;
    applyOrigin(origin, firstChild(jointElement, 'origin'));
    links[parentName].add(origin);

    const joint = new THREE.Group();
    joint.name = name;
    origin.add(joint);
    joint.add(links[childName]);
    if (type === 'fixed') continue;
    if (type !== 'revolute' && type !== 'continuous') throw new Error(`Unsupported CAD joint type: ${type}.`);

    const axis = new THREE.Vector3().fromArray(vector(firstChild(jointElement, 'axis')?.getAttribute('xyz'), [1, 0, 0])).normalize();
    const limit = firstChild(jointElement, 'limit');
    const lower = type === 'continuous' ? -Infinity : Number(limit.getAttribute('lower'));
    const upper = type === 'continuous' ? Infinity : Number(limit.getAttribute('upper'));
    jointDefinitions[name] = { axis, lower, upper };
    joint.userData = { axis: axis.toArray(), lower, upper, source: 'so101_new_calib.urdf' };
    joints[name] = joint;
    // Origins remain accurate label anchors when the descendants rotate.
    markers[name] = origin;
  }

  for (const [name, link] of Object.entries(links)) if (!childLinks.has(name)) native.add(link);
  await Promise.all(visualLoads);

  const pose = { ...ROBOT_REFERENCE_POSE };
  function setPose(values = {}) {
    for (const name of ROBOT_JOINT_NAMES) {
      if (values[name] !== undefined) {
        if (!Number.isFinite(values[name])) throw new TypeError(`${name} must be a finite number.`);
        pose[name] = values[name];
      }
      const definition = jointDefinitions[name];
      if (!definition) throw new Error(`Required CAD joint ${name} is absent.`);
      if (name === 'gripper') pose[name] = THREE.MathUtils.clamp(pose[name], 0, 100);
      const radians = name === 'gripper'
        ? THREE.MathUtils.lerp(definition.lower, definition.upper, pose[name] / 100)
        : THREE.MathUtils.clamp(THREE.MathUtils.degToRad(pose[name]), definition.lower, definition.upper);
      if (name !== 'gripper') pose[name] = THREE.MathUtils.radToDeg(radians);
      // Rotate in the joint frame after the immutable URDF origin transform.
      joints[name].quaternion.setFromAxisAngle(definition.axis, radians);
    }
    root.updateMatrixWorld(true);
    return { ...pose };
  }
  setPose(options.pose || ROBOT_REFERENCE_POSE);

  const metadata = {
    model: robotElement.getAttribute('name'),
    units: 'metres',
    upAxis: 'Y',
    source: urdfURL.href,
    referencePose: { ...ROBOT_REFERENCE_POSE },
    referenceRootYaw: 0,
    referenceDescription: 'IMG_1892: first long link extends toward −X, 3.96775° above horizontal at the CAD shoulder stop; second long link vertical; gripper longitudinal axis +X horizontal.',
    referencePhoto: 'IMG_1892.JPG',
    referenceLimitNote: 'Exact first-link horizontal would require shoulder_lift −103.96775°, beyond the official −100° CAD limit; the authored pose preserves that limit.',
    gripperMapping: '0..100 percent maps linearly across the URDF gripper limits (approximately −10..100 CAD degrees); 0 is the CAD closed stop.',
    limits: Object.fromEntries(Object.entries(jointDefinitions).map(([name, joint]) => [name, name === 'gripper' ? [0, 100] : [
      THREE.MathUtils.radToDeg(joint.lower),
      THREE.MathUtils.radToDeg(joint.upper),
    ]])),
    urdfLimits: Object.fromEntries(Object.entries(jointDefinitions).map(([name, joint]) => [name, {
      lowerDegrees: THREE.MathUtils.radToDeg(joint.lower),
      upperDegrees: THREE.MathUtils.radToDeg(joint.upper),
    }])),
    meshCount: visualLoads.length,
    uniqueMeshes: geometries.size,
    physicalCalibration: false,
  };
  root.userData.metadata = metadata;
  return { root, joints, setPose, markers, metadata };
}
