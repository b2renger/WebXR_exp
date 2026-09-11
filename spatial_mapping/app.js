import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Physics } from './physics.js';
import { Surfaces, toOBJ } from './surfaces.js';
import { XRMenu } from './xr-menu.js';
import { Tear } from './tear.js';
import { HandInput } from './hand-input.js';

const log = window.SpatialLog;
log?.record('app.module_loaded', { three: THREE.REVISION });

const $ = id => document.getElementById(id);
const scene = new THREE.Scene();
const background = new THREE.Color('#101918');
scene.background = background;
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.03, 60);
camera.position.set(5, 3.6, 6);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
$('viewport').append(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.addEventListener('start', () => log?.record('orbit.start', { position: camera.position.toArray(), target: controls.target.toArray() }));
controls.addEventListener('end', () => log?.record('orbit.end', { position: camera.position.toArray(), target: controls.target.toArray() }));
renderer.domElement.addEventListener('webglcontextlost', event => log?.record('webgl.context_lost', { message: event.statusMessage }, 'error'));
renderer.domElement.addEventListener('webglcontextrestored', () => log?.record('webgl.context_restored'));
controls.target.set(-0.35, 0.85, -0.3);
controls.enableDamping = true;
controls.maxDistance = 14;
controls.minDistance = 0.5;
controls.update();
scene.add(new THREE.HemisphereLight('#e5ffe7', '#354739', 2));
const light = new THREE.PointLight('#6dffe0', 12, 8, 2);
scene.add(light);
const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12),
  new THREE.MeshBasicMaterial({ color: light.color }));
scene.add(lamp);
const grid = new THREE.GridHelper(5, 25, '#3d6a50', '#263e31');
grid.position.y = 0.003;
scene.add(grid);

const physics = await Physics.create(scene);
log?.record('physics.ready');
const tear = new Tear(scene);
const hands = new HandInput(scene, tear.uniforms);
const surfaces = new Surfaces(scene, physics, tear.uniforms);
surfaces.createDemo();
const colors = ['#6dffe0', '#ffb768', '#b49aff', '#ff7298'];
const colorNames = ['Mint', 'Amber', 'Violet', 'Rose'];
const modes = ['relight', 'solid', 'scan', 'hidden', 'tear'];
const modeNames = ['Light overlay', 'Virtual room', 'Scan tint', 'Passthrough', 'Reality / Mesh'];
const state = { mode: 'relight', color: 0, strength: 0.65, dim: 0.2, wire: true, pinned: false };
let session = null, arSupported = false, captureUsed = false, awaitingMenuPose = false;
let savedRoom = [], savedCamera = null, lastTime = 0, lastUI = 0, sessionStart = 0;
let observed = { meshes: null, planes: null }, message = 'Desktop sample room. Drag to orbit; launch a ball to test collisions.';
let messageUntil = 0;
const raycaster = new THREE.Raycaster();
const origin = new THREE.Vector3(), direction = new THREE.Vector3();
const controllers = [];
const viewerEye = new THREE.Vector3();
let lastStyle = '', lastPoseLog = 0, lastHeartbeat = 0, frameCount = 0, lastTracking = null;
const gamepadStates = new WeakMap();
function sourceInfo(source) { return source ? { handedness: source.handedness, targetRayMode: source.targetRayMode, profiles: Array.from(source.profiles || []), hand: Boolean(source.hand) } : null; }
function inputLog(name, controller, extra = {}) {
  log?.record('input.' + name, { source: sourceInfo(controller.userData.source), ...extra });
}

function notify(text, duration = 6000) { message = text; messageUntil = performance.now() + duration; $('status').textContent = text; log?.record('app.message', { text }); }
function syncStyle() {
  const serialized = JSON.stringify(state);
  if (serialized !== lastStyle) { log?.record('settings.changed', { previous: lastStyle ? JSON.parse(lastStyle) : null, current: { ...state } }); lastStyle = serialized; }
  const enteringTear = state.mode === 'tear' && surfaces.mode !== 'tear';
  if (enteringTear || state.mode !== 'tear') tear.reset();
  if (enteringTear) physics.clear();
  tear.enabled = state.mode === 'tear';
  if (!tear.enabled) hands.hide();
  surfaces.setStyle(state.mode, state.wire);
  surfaces.material.uniforms.tearDesktop.value = session ? 0 : 1;
  $('tear-controls').hidden = !tear.enabled;
  $('throw').disabled = tear.enabled;
  lamp.visible = !tear.enabled;
  grid.visible = !session && !tear.enabled;
  const uniforms = surfaces.material.uniforms;
  uniforms.lightColor.value.set(colors[state.color]);
  uniforms.strength.value = state.strength;
  uniforms.dimming.value = state.dim;
  light.color.set(colors[state.color]); lamp.material.color.copy(light.color);
  light.intensity = state.strength * 20;
  $('mode').value = state.mode;
  $('wire').checked = state.wire;
  $('strength').value = state.strength; $('dim').value = state.dim;
  $('strength-value').textContent = Math.round(state.strength * 100) + '%';
  $('dim-value').textContent = Math.round(state.dim * 100) + '%';
  $('pin').textContent = state.pinned ? 'Unpin light' : 'Pin light';
  document.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.color) === state.color)));
}
function cycleMode() { state.mode = modes[(modes.indexOf(state.mode) + 1) % modes.length]; syncStyle(); }
function cycleColor() { state.color = (state.color + 1) % colors.length; syncStyle(); }
function togglePin() { state.pinned = !state.pinned; syncStyle(); }
function toggleTear() {
  if (!surfaces.stats().count) { notify('No room geometry yet. Use Set up room first.'); return; }
  tear.toggle(session ? renderer.xr.getCamera() : camera);
}
async function captureRoom() {
  log?.record('room.capture_requested', { session: Boolean(session), alreadyRequested: captureUsed });
  if (!session) { notify('Enter AR to capture your room.'); return; }
  if (typeof session.initiateRoomCapture !== 'function') {
    notify('Room capture API unavailable. Exit AR, run Space Setup in headset settings, then re-enter.'); return;
  }
  if (captureUsed) { notify('Capture was already requested. Exit and re-enter AR to request it again.'); return; }
  captureUsed = true;
  try { await session.initiateRoomCapture(); log?.record('room.capture_returned'); notify('Room setup returned. Waiting for localized surfaces…'); }
  catch (error) { log?.error('room.capture_failed', error); notify('Room setup: ' + error.message + '. Use headset Space Setup if necessary.'); }
}
function shoot(from = null) {
  if (state.mode === 'tear') return;
  if (!surfaces.stats().count) { notify('No collision surfaces yet. Use Set up room first.'); return; }
  if (from) {
    from.updateWorldMatrix(true, false);
    origin.setFromMatrixPosition(from.matrixWorld);
    direction.set(0, 0, -1).transformDirection(from.matrixWorld);
  } else {
    const view = session ? renderer.xr.getCamera() : camera;
    view.getWorldPosition(origin); view.getWorldDirection(direction);
  }
  origin.addScaledVector(direction, 0.18);
  physics.launch(origin, direction);
  log?.record('ball.launched', { position: origin.toArray(), direction: direction.toArray(), source: from ? sourceInfo(from.userData.source) : 'view', count: physics.balls.length });
}
const menu = new XRMenu([
  { label: () => 'View: ' + modeNames[modes.indexOf(state.mode)], run: cycleMode },
  { label: () => 'Color: ' + colorNames[state.color], run: cycleColor },
  { label: () => 'Light: ' + Math.round(state.strength * 100) + '%', run: () => { state.strength = state.strength >= 0.99 ? 0 : Math.min(1, state.strength + 0.2); syncStyle(); } },
  { label: () => 'Dim: ' + Math.round(state.dim * 100) + '%', run: () => { state.dim = state.dim >= 0.79 ? 0 : Math.min(0.8, state.dim + 0.2); syncStyle(); } },
  { label: () => state.mode === 'tear' ? 'Return to reality' : state.wire ? 'Wireframe: on' : 'Wireframe: off', run: () => {
    if (state.mode === 'tear') tear.reset(); else { state.wire = !state.wire; syncStyle(); }
  } },
  { label: () => state.pinned ? 'Unpin light' : 'Pin light', run: togglePin },
  { label: () => captureUsed ? 'Room setup help' : 'Set up room', run: captureRoom },
  { label: () => 'Clear balls', run: () => physics.clear() },
  { label: () => state.mode === 'tear' ? (tear.inMesh ? 'Tear back to reality' : 'Tear into mesh') : 'Launch ball', run: () => state.mode === 'tear' ? toggleTear() : shoot() },
  { label: () => 'Exit AR / keep scan', run: () => { log?.record('xr.exit_requested'); return session?.end().catch(error => { log?.error('xr.exit_failed', error); notify(error.message); }); } },
]);
scene.add(menu.mesh);

for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: '#dbffc5', transparent: true, opacity: 0.6 }));
  line.scale.z = 2;
  line.material.depthTest = false; line.renderOrder = 101;
  controller.userData.menuPointer = i; controller.userData.menuRay = line;
  controller.add(line); scene.add(controller); controllers.push(controller);
  controller.addEventListener('connected', e => { controller.userData.source = e.data; inputLog('connected', controller); });
  controller.addEventListener('disconnected', () => { inputLog('disconnected', controller); controller.userData.source = null; controller.userData.held = false; controller.userData.menuConsumed = false; clearMenuPointer(controller); tear.cancelGesture(); });
  controller.addEventListener('selectstart', () => {
    if (!session || session.visibilityState !== 'visible' || !controller.userData.menuTracked) return;
    if (controller.userData.held || controller.userData.menuConsumed) return;
    controller.updateWorldMatrix(true, false);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
    controller.userData.menuConsumed = menu.select(raycaster, i);
    inputLog('selectstart', controller, { menuConsumed: controller.userData.menuConsumed, origin: raycaster.ray.origin.toArray(), direction: raycaster.ray.direction.toArray() });
    controller.userData.held = !controller.userData.menuConsumed;
    if (!controller.userData.menuConsumed && state.mode !== 'tear') shoot(controller);
  });
  controller.addEventListener('selectend', () => { inputLog('selectend', controller); controller.userData.held = false; controller.userData.menuConsumed = false; menu.release(i); });
  controller.addEventListener('squeezestart', () => {
    inputLog('squeezestart', controller);
    if (controller.userData.source?.handedness === 'left') menu.place(renderer.xr.getCamera());
    else if (state.mode !== 'tear') togglePin();
  });
  controller.addEventListener('squeezeend', () => inputLog('squeezeend', controller));
}

function clearMenuPointer(controller) {
  menu.clearPointer(controller.userData.menuPointer);
  controller.userData.menuTracked = false;
  controller.userData.menuRay.scale.z = 2;
  controller.userData.menuRay.material.color.set('#dbffc5');
}
function updateMenuPointers(frame, referenceSpace) {
  for (const controller of controllers) {
    const source = controller.userData.source;
    const pose = source && frame.getPose(source.targetRaySpace, referenceSpace);
    if (!pose) { clearMenuPointer(controller); continue; }
    controller.userData.menuTracked = true;
    // Use this XR frame's target-ray pose, including hand-selection rays.
    const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
    raycaster.ray.origin.setFromMatrixPosition(matrix);
    raycaster.ray.direction.set(0, 0, -1).transformDirection(matrix);
    const hit = menu.updatePointer(raycaster, controller.userData.menuPointer);
    const line = controller.userData.menuRay;
    line.scale.z = hit ? hit.distance : 2;
    line.material.color.set(hit?.index >= 0 ? '#d1ff94' : '#dbffc5');
  }
}

function endSession() {
  log?.record('xr.session_ended', { durationMs: performance.now() - sessionStart, surfaces: surfaces.stats(), balls: physics.balls.length });
  void log?.flush();
  if (surfaces.source !== 'demo') {
    const snapshot = surfaces.snapshot(true);
    if (snapshot.length) savedRoom = snapshot;
  }
  session = null;
  tear.reset(); hands.hide();
  for (const controller of controllers) { controller.userData.held = false; controller.userData.menuConsumed = false; clearMenuPointer(controller); }
  physics.clear(); surfaces.createDemo();
  camera.position.copy(savedCamera.position); camera.quaternion.copy(savedCamera.quaternion);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  controls.target.copy(savedCamera.target); controls.enabled = true; controls.update();
  scene.background = background; renderer.setClearColor(background, 1);
  grid.visible = true; menu.mesh.visible = false; state.pinned = false; syncStyle();
  document.body.classList.remove('xr');
  $('enter').textContent = 'Enter room in AR'; $('enter').disabled = !arSupported;
  $('capture').disabled = true;
  $('export').textContent = savedRoom.length ? 'Download captured room (.obj)' : 'Download sample room (.obj)';
  notify(savedRoom.length ? 'AR ended. Your last localized scan is ready to download below.' : 'AR ended. No room scan was captured.');
}
async function enterAR() {
  log?.record('xr.session_requested', { mode: 'immersive-ar', requiredFeatures: ['local-floor'], optionalFeatures: ['mesh-detection', 'plane-detection', 'hand-tracking'] });
  $('enter').disabled = true;
  let requested = null;
  try {
    requested = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['mesh-detection', 'plane-detection', 'hand-tracking'],
    });
    savedCamera = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), target: controls.target.clone() };
    session = requested; captureUsed = false; observed = { meshes: null, planes: null };
    log?.record('xr.session_granted', { enabledFeatures: Array.from(requested.enabledFeatures || []), blendMode: requested.environmentBlendMode, visibility: requested.visibilityState });
    requested.addEventListener('inputsourceschange', event => log?.record('xr.inputs_changed', { added: Array.from(event.added, sourceInfo), removed: Array.from(event.removed, sourceInfo) }));
    tear.reset(); hands.hide();
    physics.clear(); surfaces.clear(); surfaces.source = 'waiting';
    // Desktop orbit offset must never be added to the headset's local-floor pose.
    controls.enabled = false; camera.position.set(0, 0, 0); camera.quaternion.identity(); camera.updateMatrixWorld(true);
    scene.background = null; renderer.setClearColor(0x000000, 0); grid.visible = false;
    state.pinned = false; syncStyle();
    requested.addEventListener('end', endSession, { once: true });
    requested.addEventListener('visibilitychange', () => {
      log?.record('xr.visibility', { state: requested.visibilityState }); void log?.flush();
      lastTime = 0; physics.accumulator = 0; tear.reset(); hands.hide();
      for (const controller of controllers) { controller.userData.held = false; controller.userData.menuConsumed = false; clearMenuPointer(controller); }
    });
    await renderer.xr.setSession(requested);
    renderer.xr.getReferenceSpace().addEventListener('reset', () => {
      log?.record('xr.reference_reset', {}, 'warn');
      physics.clear(); state.pinned = false; awaitingMenuPose = true; syncStyle();
      for (const controller of controllers) clearMenuPointer(controller);
      tear.reset(); hands.hide();
      notify('Tracking origin changed. Balls cleared; surfaces will follow the new poses.');
    });
    sessionStart = performance.now(); awaitingMenuPose = true; lastTime = 0;
    lastTracking = null;
    log?.record('xr.session_rendering', { referenceSpace: 'local-floor' });
    menu.mesh.visible = true; document.body.classList.add('xr');
    $('capture').disabled = false;
    notify('Look around. If no surfaces appear, choose Set up room.');
  } catch (error) {
    log?.error('xr.session_failed', error);
    if (requested) {
      try { await requested.end(); } catch { if (session) endSession(); }
    }
    $('enter').disabled = !arSupported;
    notify('Could not enter AR: ' + error.name + ' — ' + error.message);
  }
}

$('enter').addEventListener('click', enterAR);
$('mode').addEventListener('change', e => { state.mode = e.target.value; syncStyle(); });
$('wire').addEventListener('change', e => { state.wire = e.target.checked; syncStyle(); });
for (const field of ['strength', 'dim']) $(field).addEventListener('input', e => { state[field] = Number(e.target.value); syncStyle(); });
document.querySelectorAll('[data-color]').forEach(b => b.addEventListener('click', () => { state.color = Number(b.dataset.color); syncStyle(); }));
$('throw').addEventListener('click', () => shoot());
$('pin').addEventListener('click', togglePin);
$('capture').addEventListener('click', captureRoom);
$('clear').addEventListener('click', () => physics.clear());
$('tear-toggle').addEventListener('click', toggleTear);
$('tear-reset').addEventListener('click', () => tear.reset());
$('export').addEventListener('click', () => {
  const snapshot = savedRoom.length ? savedRoom : surfaces.snapshot();
  if (!snapshot.length) { notify('No localized surfaces to export.'); return; }
  log?.record('room.export', { captured: Boolean(savedRoom.length), surfaces: snapshot.length, vertices: snapshot.reduce((n, surface) => n + surface.vertices.length / 3, 0) });
  const url = URL.createObjectURL(new Blob([toOBJ(snapshot)], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url; a.download = savedRoom.length ? 'quest-room.obj' : 'sample-room.obj'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
});
syncStyle();

renderer.setAnimationLoop((time, frame) => {
  frameCount++;
  const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0;
  lastTime = time;
  if (session && frame) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    const viewer = frame.getViewerPose(referenceSpace);
    const tracked = Boolean(viewer && session.visibilityState === 'visible');
    if (tracked !== lastTracking) { log?.record('xr.tracking', { tracked, visibility: session.visibilityState }, tracked ? 'info' : 'warn'); lastTracking = tracked; }
    if (viewer && session.visibilityState === 'visible') {
      observed = surfaces.updateXR(frame, referenceSpace);
      viewerEye.copy(viewer.transform.position);
      for (const source of session.inputSources) if (source.gamepad) {
        const buttons = source.gamepad.buttons.map(button => ({ pressed: button.pressed, touched: button.touched }));
        const encoded = JSON.stringify(buttons);
        if (gamepadStates.get(source) !== encoded) { log?.record('input.buttons', { source: sourceInfo(source), buttons }); gamepadStates.set(source, encoded); }
      }
      if (log?.motion && time - lastPoseLog >= 200) {
        lastPoseLog = time;
        const inputs = Array.from(session.inputSources, source => {
          const grip = frame.getPose(source.gripSpace || source.targetRaySpace, referenceSpace);
          return { source: sourceInfo(source), matrix: grip ? Array.from(grip.transform.matrix) : null,
            axes: source.gamepad ? Array.from(source.gamepad.axes) : null,
            buttons: source.gamepad?.buttons.map(button => ({ pressed: button.pressed, touched: button.touched, value: button.value })) };
        });
        log.record('xr.pose_sample', { referenceSpace: 'local-floor', viewer: Array.from(viewer.transform.matrix), inputs, light: lamp.position.toArray(), tear: { progress: tear.progress, inMesh: tear.inMesh } }, 'debug');
      }
      if (state.mode === 'tear' && surfaces.stats().count) {
        const input = hands.sample(frame, referenceSpace, session.inputSources, controllers, true);
        tear.gesture(input.left, input.right, viewerEye);
      } else hands.hide();
      if (awaitingMenuPose) {
        // Use this frame's viewer transform: Three's XR camera updates during render.
        const viewerObject = new THREE.Object3D();
        viewerObject.matrix.fromArray(viewer.transform.matrix);
        viewerObject.matrix.decompose(viewerObject.position, viewerObject.quaternion, viewerObject.scale);
        menu.place(viewerObject); awaitingMenuPose = false;
      }
      updateMenuPointers(frame, referenceSpace);
      if (!state.pinned) {
        const right = controllers.find(c => c.userData.source?.handedness === 'right' && c.visible);
        if (right) { right.updateWorldMatrix(true, false); lamp.position.set(0, 0, -0.12).applyMatrix4(right.matrixWorld); }
        else lamp.position.set(0.2, -0.2, -0.45).applyMatrix4(new THREE.Matrix4().fromArray(viewer.transform.matrix));
      }
      physics.update(dt);
    } else {
      physics.accumulator = 0;
      for (const controller of controllers) clearMenuPointer(controller);
      tear.reset(); hands.hide();
      // Do not keep stale collision surfaces active while tracking is unavailable.
      for (const record of surfaces.records.values()) surfaces.pose(record, null);
    }
  } else if (!session) {
    controls.update();
    camera.getWorldPosition(viewerEye);
    if (!state.pinned) lamp.position.set(Math.sin(time * 0.0005) * 1.3, 1.6, Math.cos(time * 0.0004) * 0.8 - 0.5);
    physics.update(dt);
  }
  light.position.copy(lamp.position);
  tear.enabled = state.mode === 'tear' && surfaces.stats().count > 0;
  if (!tear.enabled) tear.reset();
  tear.update(dt, viewerEye);
  surfaces.material.uniforms.lightPosition.value.copy(lamp.position);
  if (time - lastUI > 250) {
    lastUI = time;
    const stats = surfaces.stats();
    if (session && time > messageUntil) {
      message = stats.count ? (state.mode === 'tear' ?
        'Hands close together: pinch both / hold both triggers, pull apart, then release. Repeat to return.' :
        'Move the right controller to paint light. Trigger launches a ball.') :
        time - sessionStart > 8000 ? 'No localized surfaces. Set up room; check spatial permissions, then re-enter AR.' : 'Waiting for room geometry…';
    }
    $('status').textContent = message;
    $('tear-state').textContent = (tear.inMesh ? 'Mesh' : 'Reality') + (tear.dragging ? ` · Tear ${Math.round(tear.progress * 100)}% · release after 50% to finish` : ' · Pinch both hands, pull apart, then release.');
    $('tear-toggle').textContent = tear.inMesh ? 'Tear back to reality' : 'Tear into mesh';
    $('preview-note').innerHTML = state.mode === 'tear' ? '<span class="dot"></span> REALITY ↔ MESH · SYNTHETIC PREVIEW <small>Use Tear into mesh · Real passthrough appears on Quest</small>' : '<span class="dot"></span> DESKTOP SAMPLE ROOM <small>Drag to explore · Enter AR to use your real room</small>';
    $('surfaces').textContent = stats.count; $('triangles').textContent = stats.triangles.toLocaleString(); $('balls').textContent = physics.balls.length;
    $('diagnostics').textContent = JSON.stringify({ secureContext: isSecureContext, arSupported,
      enabledFeatures: session?.enabledFeatures ? Array.from(session.enabledFeatures) : null,
      environmentBlendMode: session?.environmentBlendMode ?? null, detectedMeshes: observed.meshes,
      detectedPlanes: observed.planes, source: stats.source, localizedSurfaces: stats.count,
      roomCapture: session ? typeof session.initiateRoomCapture === 'function' : null,
      visibility: session?.visibilityState ?? 'desktop', savedSurfaces: savedRoom.length,
      tear: { enabled: tear.enabled, inMesh: tear.inMesh, progress: tear.progress },
      hands: session ? Array.from(session.inputSources).filter(source => source.hand).length : 0 }, null, 2);
    if (session) {
      const gestureMessage = tear.dragging ? `Tear ${Math.round(tear.progress * 100)}%. ${tear.progress >= 0.5 ? 'Release to complete the transition.' : 'Pull farther apart, or release to close.'}` : message;
      menu.draw({ ...stats, message: gestureMessage, tear: state.mode === 'tear' });
    }
  }
  if (time - lastHeartbeat >= 5000) {
    log?.record('app.heartbeat', { xr: Boolean(session), mode: state.mode, surfaces: surfaces.stats(), detected: observed,
      balls: physics.balls.length, fps: lastHeartbeat ? Math.round(frameCount * 1000 / (time - lastHeartbeat)) : null,
      renderCalls: renderer.info.render.calls, renderTriangles: renderer.info.render.triangles,
      geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures });
    frameCount = 0; lastHeartbeat = time;
  }
  renderer.render(scene, camera);
});

try { arSupported = Boolean(isSecureContext && navigator.xr && await navigator.xr.isSessionSupported('immersive-ar')); }
catch (error) { log?.error('xr.support_check_failed', error); notify('AR support check failed: ' + error.message); }
log?.record('xr.support', { arSupported, secureContext: isSecureContext, xrExposed: Boolean(navigator.xr) });
$('enter').disabled = !arSupported;
$('enter').textContent = arSupported ? 'Enter room in AR' : 'AR requires a compatible XR browser';
if (!isSecureContext) notify('WebXR needs HTTPS. A Quest opening a LAN HTTP URL cannot enter AR.');
else notify(message);
document.body.dataset.ready = 'true';
log?.record('app.ready');
// Explicit opt-in for the local regression harness; no room data is uploaded.
if (new URLSearchParams(location.search).has('test')) window.spatialLab = { scene, renderer, camera, physics, surfaces, shoot, state, syncStyle, menu, tear, hands };
