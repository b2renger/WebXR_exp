import * as THREE from 'three';

// A shared world-space aperture keeps the sky, triangles, and hands in agreement
// for both eyes. The physical camera image remains the XR compositor's job.
export const tearGLSL = `
  uniform float tearBase;
  uniform float tearProgress;
  uniform vec3 tearCenter;
  uniform vec3 tearRight;
  uniform vec3 tearUp;
  uniform vec3 tearNormal;
  vec2 tearMask(vec3 worldPoint) {
    if (tearProgress <= 0.0) return vec2(tearBase, 0.0);
    vec3 ray = normalize(worldPoint - cameraPosition);
    float denominator = dot(ray, tearNormal);
    float t = dot(tearCenter - cameraPosition, tearNormal) / (abs(denominator) < 0.0001 ? 0.0001 : denominator);
    vec3 offset = cameraPosition + ray * t - tearCenter;
    float x = dot(offset, tearRight);
    float y = dot(offset, tearUp);
    float p = tearProgress;
    float width = 0.008 + p * p * 2.5;
    float height = 0.18 + p * 2.2;
    // A stable irregular edge, not time noise: the rip doesn't swim as you move.
    float jagged = sin(y * 43.0) * 0.035 + sin(y * 97.0) * 0.018;
    float d = length(vec2(x / width, y / height)) + jagged;
    float local = (1.0 - smoothstep(0.96, 1.04, d)) * step(0.0, t);
    float expansion = smoothstep(0.68, 1.0, p);
    float aperture = mix(local, 1.0, expansion);
    float edge = (1.0 - smoothstep(0.015, 0.075, abs(d - 1.0))) * step(0.0, t) * (1.0 - expansion);
    return vec2(mix(tearBase, 1.0 - tearBase, aperture), edge);
  }
`;

export function maskMaterial(material, uniforms, enabled = null) {
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    if (enabled) shader.uniforms.tearEnabled = enabled;
    shader.vertexShader = 'varying vec3 vTearWorld;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      vec4 tearVertex = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        tearVertex = instanceMatrix * tearVertex;
      #endif
      vTearWorld = (modelMatrix * tearVertex).xyz;
      #include <project_vertex>
    `);
    shader.fragmentShader = 'varying vec3 vTearWorld;\n' + (enabled ? 'uniform float tearEnabled;\n' : '') + tearGLSL + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      ${enabled ? 'if (tearEnabled > 0.5) {' : ''}
        float coverage = tearMask(vTearWorld).x;
        if (coverage < 0.003) discard;
        diffuseColor.a *= coverage;
      ${enabled ? '}' : ''}
      #include <opaque_fragment>
    `);
  };
  material.customProgramCacheKey = () => 'tear-mask-' + Boolean(enabled);
}

export class Tear {
  constructor(scene) {
    this.uniforms = {
      tearBase: { value: 0 }, tearProgress: { value: 0 },
      tearCenter: { value: new THREE.Vector3(0, 1.5, -0.5) },
      tearRight: { value: new THREE.Vector3(1, 0, 0) },
      tearUp: { value: new THREE.Vector3(0, 1, 0) },
      tearNormal: { value: new THREE.Vector3(0, 0, 1) },
    };
    this.enabled = false;
    this.reset();
    this.backdrop = new THREE.Mesh(new THREE.SphereGeometry(30, 24, 16), new THREE.ShaderMaterial({
      uniforms: this.uniforms, side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: false,
      vertexShader: `varying vec3 worldPoint;
        void main() { worldPoint = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec3 worldPoint; ${tearGLSL}
        void main() { vec2 mask = tearMask(worldPoint);
          gl_FragColor = vec4(vec3(0.004, 0.012, 0.018) + vec3(0.1, 0.85, 1.0) * mask.y, max(mask.x, mask.y));
          #include <colorspace_fragment>
        }`,
    }));
    this.backdrop.renderOrder = -90;
    this.backdrop.frustumCulled = false;
    this.backdrop.visible = false;
    scene.add(this.backdrop);
  }
  get inMesh() { return this.uniforms.tearBase.value === 1; }
  get progress() { return this.uniforms.tearProgress.value; }
  reset() {
    if (this.dragging || this.inMesh || this.progress) globalThis.SpatialLog?.record('tear.reset', { inMesh: this.inMesh, progress: this.progress, dragging: this.dragging });
    this.uniforms.tearBase.value = 0;
    this.uniforms.tearProgress.value = 0;
    this.dragging = false; this.animation = null; this.locked = false;
  }
  orient(center, eye, right) {
    this.uniforms.tearCenter.value.copy(center);
    const normal = this.uniforms.tearNormal.value.copy(eye).sub(center).normalize();
    const u = this.uniforms.tearRight.value.copy(right).addScaledVector(normal, -right.dot(normal));
    if (u.lengthSq() < 0.001) u.set(1, 0, 0).addScaledVector(normal, -normal.x);
    if (u.lengthSq() < 0.001) u.set(0, 0, 1).addScaledVector(normal, -normal.z);
    u.normalize();
    this.uniforms.tearUp.value.crossVectors(normal, u).normalize();
  }
  toggle(camera) {
    if (this.animation !== null || this.dragging) return;
    const eye = camera.getWorldPosition(new THREE.Vector3());
    const rotation = camera.getWorldQuaternion(new THREE.Quaternion());
    const center = eye.clone().add(new THREE.Vector3(0, 0, -0.65).applyQuaternion(rotation));
    this.orient(center, eye, new THREE.Vector3(1, 0, 0).applyQuaternion(rotation));
    this.animation = 1;
    globalThis.SpatialLog?.record('tear.button_transition', { from: this.inMesh ? 'mesh' : 'reality', center: center.toArray() });
  }
  cancelGesture() {
    if (this.dragging) { globalThis.SpatialLog?.record('tear.tracking_cancelled', { progress: this.progress }, 'warn'); this.dragging = false; this.animation = 0; this.locked = true; }
  }
  gesture(left, right, eye) {
    const held = left?.held && right?.held;
    // Missing pose is a cancellation, never an implicit successful release.
    if (!left || !right) { this.cancelGesture(); return; }
    if (!held) {
      if (this.dragging) {
        globalThis.SpatialLog?.record('tear.released', { progress: this.progress, complete: this.progress >= 0.5 });
        this.dragging = false; this.animation = this.progress >= 0.5 ? 1 : 0;
      }
      this.locked = false;
      return;
    }
    if (this.animation !== null || this.locked) return;
    const separation = left.position.distanceTo(right.position);
    if (!this.dragging) {
      // Begin with hands close together, then pull apart. Already-wide grips do
      // not unexpectedly switch the world.
      if (separation > 0.35) return;
      const center = left.position.clone().add(right.position).multiplyScalar(0.5);
      if (center.distanceTo(eye) < 0.15) return;
      this.orient(center, eye, right.position.clone().sub(left.position).normalize());
      this.startSeparation = separation; this.dragging = true;
      this.loggedProgress = 0;
      globalThis.SpatialLog?.record('tear.started', { separation, center: center.toArray(), from: this.inMesh ? 'mesh' : 'reality' });
    }
    this.uniforms.tearProgress.value = THREE.MathUtils.clamp((separation - this.startSeparation) / 0.55, 0, 0.9);
    if (Math.abs(this.progress - this.loggedProgress) >= 0.1) {
      this.loggedProgress = this.progress;
      globalThis.SpatialLog?.record('tear.progress', { progress: this.progress, separation });
    }
  }
  update(dt, eye) {
    this.backdrop.visible = this.enabled;
    this.backdrop.position.copy(eye);
    if (this.animation === null) return;
    const p = this.progress, goal = this.animation;
    const next = THREE.MathUtils.clamp(p + Math.sign(goal - p) * dt * 1.4, 0, 1);
    this.uniforms.tearProgress.value = next;
    if (next === goal) {
      if (goal === 1) this.uniforms.tearBase.value = 1 - this.uniforms.tearBase.value;
      globalThis.SpatialLog?.record(goal === 1 ? 'tear.completed' : 'tear.closed', { inMesh: this.inMesh });
      this.uniforms.tearProgress.value = 0; this.animation = null;
    }
  }
}
