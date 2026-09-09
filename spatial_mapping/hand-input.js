import * as THREE from 'three';
import { maskMaterial } from './tear.js';

const chains = [
  ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  ...['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'].map(finger =>
    ['wrist', `${finger}-metacarpal`, `${finger}-phalanx-proximal`, `${finger}-phalanx-intermediate`, `${finger}-phalanx-distal`, `${finger}-tip`]),
];
const connections = chains.flatMap(chain => chain.slice(1).map((joint, i) => [chain[i], joint]));
const up = new THREE.Vector3(0, 1, 0);

export class HandInput {
  constructor(scene, uniforms) {
    this.pinches = new WeakMap();
    const material = new THREE.MeshBasicMaterial({ color: '#86dfff', transparent: true, depthTest: false, depthWrite: false });
    maskMaterial(material, uniforms);
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), material, 50);
    this.bones = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6), material, 48);
    for (const mesh of [this.joints, this.bones]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; mesh.renderOrder = 20; mesh.visible = false;
      scene.add(mesh);
    }
    this.transform = new THREE.Object3D();
  }
  hide() { this.joints.visible = false; this.bones.visible = false; }
  sample(frame, referenceSpace, sources, controllers, visible) {
    let jointCount = 0, boneCount = 0;
    const result = { left: null, right: null };
    for (const source of sources) {
      if (!['left', 'right'].includes(source.handedness)) continue;
      const controller = controllers.find(c => c.userData.source === source);
      const blocked = controller?.userData.menuConsumed;
      if (!source.hand) {
        const pose = frame.getPose(source.gripSpace || source.targetRaySpace, referenceSpace);
        if (pose) result[source.handedness] = { position: new THREE.Vector3().copy(pose.transform.position), held: Boolean(controller?.userData.held && !blocked) };
        continue;
      }
      const poses = new Map();
      for (const [name, space] of source.hand) {
        const pose = frame.getJointPose(space, referenceSpace);
        if (!pose) continue;
        const position = new THREE.Vector3().copy(pose.transform.position);
        poses.set(name, position);
        if (jointCount < 50) {
          this.transform.position.copy(position); this.transform.quaternion.identity();
          this.transform.scale.setScalar(pose.radius || 0.007); this.transform.updateMatrix();
          this.joints.setMatrixAt(jointCount++, this.transform.matrix);
        }
      }
      for (const [a, b] of connections) {
        const start = poses.get(a), end = poses.get(b);
        if (!start || !end || boneCount >= 48) continue;
        const delta = end.clone().sub(start);
        if (delta.lengthSq() < 1e-8) continue;
        this.transform.position.copy(start).add(end).multiplyScalar(0.5);
        this.transform.scale.set(0.005, delta.length(), 0.005);
        this.transform.quaternion.setFromUnitVectors(up, delta.normalize()); this.transform.updateMatrix();
        this.bones.setMatrixAt(boneCount++, this.transform.matrix);
      }
      const thumb = poses.get('thumb-tip'), index = poses.get('index-finger-tip');
      if (thumb && index) {
        // Hysteresis prevents a noisy fingertip estimate from rapidly releasing.
        const held = thumb.distanceTo(index) < (this.pinches.get(source) ? 0.04 : 0.025);
        this.pinches.set(source, held);
        result[source.handedness] = { position: thumb.clone().add(index).multiplyScalar(0.5), held: held && !blocked };
      } else this.pinches.delete(source);
    }
    this.joints.count = jointCount; this.bones.count = boneCount;
    this.joints.instanceMatrix.needsUpdate = true; this.bones.instanceMatrix.needsUpdate = true;
    this.joints.visible = visible && jointCount > 0; this.bones.visible = visible && boneCount > 0;
    return result;
  }
}
