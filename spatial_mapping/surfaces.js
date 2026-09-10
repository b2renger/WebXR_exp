import * as THREE from 'three';
import { tearGLSL, maskMaterial } from './tear.js';

// WebXR plane polygons lie in the local XZ plane. Earcut handles concave outlines.
export function planeGeometry(polygon) {
  const points = Array.from(polygon, p => new THREE.Vector2(p.x, p.z));
  if (points.length > 1 && points[0].distanceToSquared(points.at(-1)) < 1e-12) points.pop();
  const faces = THREE.ShapeUtils.triangulateShape(points, []);
  return {
    vertices: new Float32Array(points.flatMap(p => [p.x, 0, p.y])),
    indices: new Uint32Array(faces.flat()),
  };
}

export function createSurfaceMaterial(tearUniforms) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    uniforms: {
      lightPosition: { value: new THREE.Vector3(0, 1.5, 0) },
      lightColor: { value: new THREE.Color('#6dffe0') },
      strength: { value: 0.65 }, dimming: { value: 0.2 }, mode: { value: 0 },
      tearDesktop: { value: 0 }, ...tearUniforms,
    },
    vertexShader: `
      varying vec3 worldPosition;
      varying vec3 worldNormal;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        worldPosition = world.xyz;
        // XR surface poses are rigid transforms (no nonuniform scale).
        worldNormal = normalize(mat3(modelMatrix) * normal);
        // Match the depth-only material's transform order to avoid depth stripes.
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 lightPosition;
      uniform vec3 lightColor;
      uniform float strength;
      uniform float dimming;
      uniform int mode;
      uniform float tearDesktop;
      ${tearGLSL}
      varying vec3 worldPosition;
      varying vec3 worldNormal;
      void main() {
        vec3 delta = lightPosition - worldPosition;
        float distanceSquared = dot(delta, delta);
        float lambert = abs(dot(normalize(worldNormal), normalize(delta + vec3(0.00001))));
        float light = strength * (0.12 + 0.88 * lambert) / (1.0 + distanceSquared * 0.48);
        if (mode == 3) {
          vec2 mask = tearMask(worldPosition);
          if (tearDesktop < 0.5 && max(mask.x, mask.y) < 0.003) discard;
          vec3 meshColor = vec3(0.012, 0.055, 0.072) + light * vec3(0.02, 0.12, 0.15);
          vec3 demoColor = vec3(0.28, 0.24, 0.18) * (0.5 + abs(normalize(worldNormal).y) * 0.5);
          vec3 color = tearDesktop > 0.5 ? mix(demoColor, meshColor, mask.x) : meshColor;
          color += vec3(0.1, 0.85, 1.0) * mask.y;
          gl_FragColor = vec4(color, tearDesktop > 0.5 ? 1.0 : max(mask.x, mask.y));
        } else if (mode == 1) {
          gl_FragColor = vec4(vec3(0.055) + lightColor * light * 1.8, 1.0);
        } else if (mode == 2) {
          gl_FragColor = vec4(0.16, 0.68, 0.49, 0.17);
        } else {
          // Standard alpha compositing: darken existing image, then add a light tint.
          float alpha = clamp(dimming + light * 0.72, 0.0, 0.95);
          gl_FragColor = vec4(lightColor * light / max(alpha, 0.001), alpha);
        }
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

export class Surfaces {
  constructor(scene, physics, tearUniforms = {
    tearBase: { value: 0 }, tearProgress: { value: 0 },
    tearCenter: { value: new THREE.Vector3() }, tearRight: { value: new THREE.Vector3(1, 0, 0) },
    tearUp: { value: new THREE.Vector3(0, 1, 0) }, tearNormal: { value: new THREE.Vector3(0, 0, 1) },
  }) {
    this.scene = scene;
    this.physics = physics;
    this.records = new Map();
    this.material = createSurfaceMaterial(tearUniforms);
    this.depthMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.wireMaterial = new THREE.MeshBasicMaterial({ color: '#9cf4c7', wireframe: true,
      transparent: true, opacity: 0.18, depthWrite: false });
    this.tearEnabled = { value: 0 };
    maskMaterial(this.wireMaterial, tearUniforms, this.tearEnabled);
    this.mode = 'relight';
    this.showWire = true;
    this.source = 'demo';
  }
  add(key, data, label = '', changed = 0) {
    if (!data.indices.length || !data.vertices.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(data.vertices), 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(data.indices), 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    const depth = new THREE.Mesh(geometry, this.depthMaterial);
    depth.renderOrder = -100;
    const surface = new THREE.Mesh(geometry, this.material);
    const wire = new THREE.Mesh(geometry, this.wireMaterial);
    wire.renderOrder = 2;
    group.add(depth, surface, wire);
    this.scene.add(group);
    const collider = this.physics.addSurface(data.vertices, data.indices);
    const record = { group, geometry, surface, wire, collider, label, changed, localized: false, pose: null };
    collider.setEnabled(false);
    group.visible = false;
    this.records.set(key, record);
    this.applyStyle(record);
    return record;
  }
  applyStyle(record) {
    record.surface.visible = this.mode !== 'hidden';
    record.wire.visible = this.mode === 'tear' || (this.showWire && this.mode !== 'hidden');
  }
  setStyle(mode, wire) {
    this.mode = mode;
    this.showWire = wire;
    this.material.uniforms.mode.value = { relight: 0, solid: 1, scan: 2, hidden: 0, tear: 3 }[mode];
    this.tearEnabled.value = mode === 'tear' ? 1 : 0;
    this.wireMaterial.color.set(mode === 'tear' ? '#49dfff' : '#9cf4c7');
    this.wireMaterial.opacity = mode === 'tear' ? 0.85 : 0.18;
    for (const record of this.records.values()) this.applyStyle(record);
  }
  pose(record, matrix) {
    record.group.visible = Boolean(matrix);
    record.localized = Boolean(matrix);
    record.collider.setEnabled(Boolean(matrix));
    if (!matrix) return;
    record.group.matrix.fromArray(matrix);
    record.group.matrixWorldNeedsUpdate = true;
    // Geometry change timestamps exclude pose changes: compare pose independently.
    if (!record.pose || matrix.some((v, i) => Math.abs(v - record.pose[i]) > 1e-6)) {
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      record.group.matrix.decompose(p, q, s);
      record.collider.setTranslation(p);
      record.collider.setRotation(q);
      record.pose = Array.from(matrix);
    }
  }
  remove(key) {
    const record = this.records.get(key);
    this.scene.remove(record.group);
    record.geometry.dispose();
    this.physics.removeSurface(record.collider);
    this.records.delete(key);
  }
  clear() { for (const key of this.records.keys()) this.remove(key); }
  updateXR(frame, referenceSpace) {
    const meshes = frame.detectedMeshes;
    const planes = frame.detectedPlanes;
    // Use localized meshes when available; otherwise use planes. Never stack both
    // colliders over the same surfaces (that creates jitter and double shading).
    const poses = new Map();
    if (meshes) for (const mesh of meshes) {
      const pose = frame.getPose(mesh.meshSpace, referenceSpace);
      if (pose && mesh.indices.length) poses.set(mesh, pose);
    }
    // Keep mesh records during temporary tracking loss if no plane fallback exists.
    // Their render/collision state is disabled below, while the last pose survives export.
    const useMeshes = poses.size > 0 || (meshes?.size > 0 && !planes?.size);
    const detected = useMeshes ? meshes : (planes || new Set());
    this.source = useMeshes ? 'mesh' : planes?.size ? 'plane fallback' : 'waiting';
    for (const key of this.records.keys()) if (!detected.has(key)) this.remove(key);
    for (const item of detected) {
      let record = this.records.get(item);
      if (record && record.changed !== item.lastChangedTime) { this.remove(item); record = null; }
      if (!record) {
        const data = useMeshes ? { vertices: item.vertices, indices: item.indices } : planeGeometry(item.polygon);
        record = this.add(item, data, item.semanticLabel || (useMeshes ? 'mesh' : 'plane'), item.lastChangedTime);
      }
      if (record) this.pose(record, (useMeshes ? poses.get(item) : frame.getPose(item.planeSpace, referenceSpace))?.transform.matrix);
    }
    return { meshes: meshes?.size ?? null, planes: planes?.size ?? null };
  }
  stats() {
    let count = 0, triangles = 0;
    for (const r of this.records.values()) if (r.localized) { count++; triangles += r.geometry.index.count / 3; }
    return { count, triangles, source: this.source };
  }
  snapshot(includeLastKnown = false) {
    return [...this.records.values()].filter(r => r.localized || (includeLastKnown && r.pose)).map(r => ({
      label: r.label, vertices: Array.from(r.geometry.attributes.position.array),
      indices: Array.from(r.geometry.index.array), matrix: Array.from(r.group.matrix.elements),
    }));
  }
  createDemo() {
    this.clear();
    this.source = 'demo';
    const box = (name, size, position) => {
      const geometry = new THREE.BoxGeometry(...size);
      const record = this.add(name, { vertices: geometry.attributes.position.array, indices: geometry.index.array }, name);
      this.pose(record, new THREE.Matrix4().makeTranslation(...position).elements);
      geometry.dispose();
    };
    box('floor', [5, 0.12, 4], [0, -0.06, 0]);
    box('back_wall', [5, 2.8, 0.1], [0, 1.4, -2]);
    box('left_wall', [0.1, 2.8, 4], [-2.5, 1.4, 0]);
    box('table', [1.4, 0.1, 0.9], [0, 0.8, -0.45]);
    for (const x of [-0.58, 0.58]) for (const z of [-0.78, -0.12]) box('leg_' + x + '_' + z, [0.08, 0.75, 0.08], [x, 0.375, z]);
    box('seat', [1.3, 0.45, 0.65], [1.6, 0.225, -1.5]);
    box('backrest', [1.3, 0.55, 0.12], [1.6, 0.7, -1.78]);
  }
}

export function toOBJ(snapshot) {
  const lines = ['# WebXR room snapshot; meters; Y up; session local-floor coordinates', '# Geometry only. No textures or persistent spatial alignment.'];
  let offset = 1;
  const p = new THREE.Vector3();
  for (const [i, surface] of snapshot.entries()) {
    lines.push('o ' + i + '_' + surface.label.replace(/[^a-zA-Z0-9_-]/g, '_'));
    const matrix = new THREE.Matrix4().fromArray(surface.matrix);
    for (let v = 0; v < surface.vertices.length; v += 3) {
      p.fromArray(surface.vertices, v).applyMatrix4(matrix);
      lines.push(`v ${p.x.toFixed(6)} ${p.y.toFixed(6)} ${p.z.toFixed(6)}`);
    }
    for (let f = 0; f < surface.indices.length; f += 3) {
      lines.push(`f ${surface.indices[f] + offset} ${surface.indices[f + 1] + offset} ${surface.indices[f + 2] + offset}`);
    }
    offset += surface.vertices.length / 3;
  }
  return lines.join('\n') + '\n';
}
