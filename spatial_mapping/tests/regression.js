import * as THREE from 'three';
import { Physics } from '../physics.js';
import { Surfaces, planeGeometry, toOBJ } from '../surfaces.js';
import { Tear } from '../tear.js';
import { HandInput } from '../hand-input.js';

export async function run(lab) {
  const passed = [];
  function assert(condition, message) { if (!condition) throw new Error(message); passed.push(message); }
  const points = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 0]].map(([x, z]) => ({ x, z }));
  const concave = planeGeometry(points);
  let area = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < concave.indices.length; i += 3) {
    a.fromArray(concave.vertices, concave.indices[i] * 3);
    b.fromArray(concave.vertices, concave.indices[i + 1] * 3);
    c.fromArray(concave.vertices, concave.indices[i + 2] * 3);
    area += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  assert(Math.abs(area - 3) < 1e-6, 'Concave plane triangulates without filling the missing corner');

  const physics = await Physics.create(new THREE.Scene());
  const surfaces = new Surfaces(physics.scene, physics);
  const data = planeGeometry([[-2, -2], [-2, 2], [2, 2], [2, -2]].map(([x, z]) => ({ x, z })));
  const mesh = { ...data, meshSpace: {}, lastChangedTime: 1, semanticLabel: 'floor' };
  const plane = { polygon: points, planeSpace: {}, lastChangedTime: 1, semanticLabel: 'table' };
  let located = true;
  let matrix = new THREE.Matrix4().makeTranslation(0, 1, 0).elements;
  const frame = { detectedMeshes: new Set([mesh]), detectedPlanes: new Set([plane]),
    getPose: () => located ? { transform: { matrix } } : null };
  surfaces.updateXR(frame, {});
  assert(surfaces.stats().source === 'mesh' && surfaces.records.size === 1, 'Mesh takes precedence over overlapping planes');
  let record = surfaces.records.get(mesh);
  const geometry = record.geometry;
  matrix = new THREE.Matrix4().makeTranslation(0, 2, 0).elements;
  surfaces.updateXR(frame, {});
  assert(record.geometry === geometry && Math.abs(record.collider.translation().y - 2) < 1e-6,
    'Pose-only update moves collider without rebuilding geometry');
  physics.launch(new THREE.Vector3(0, 3, 0), new THREE.Vector3());
  for (let i = 0; i < 900; i++) physics.update(1 / 90);
  assert(Math.abs(physics.balls[0].body.translation().y - 2.065) < 0.02, 'Ball settles on transformed room triangles');
  physics.clear();
  const obj = toOBJ(surfaces.snapshot());
  assert(obj.includes('v -2.000000 2.000000 -2.000000') && obj.includes('\nf '), 'OBJ bakes surface pose into exported coordinates');
  mesh.lastChangedTime = 2;
  surfaces.updateXR(frame, {});
  record = surfaces.records.get(mesh);
  assert(record.geometry !== geometry && surfaces.records.size === 1, 'Geometry revision replaces the surface and collider');
  // Isolate pose-loss behavior from fallback to another surface representation.
  frame.detectedPlanes.clear(); located = false;
  surfaces.updateXR(frame, {});
  assert(surfaces.stats().count === 0, 'Unlocalized geometry does not remain active');
  assert(!surfaces.records.get(mesh).collider.isEnabled(), 'Lost mesh pose disables collisions');
  assert(surfaces.snapshot().length === 0 && surfaces.snapshot(true).length === 1,
    'Session exit can export last known geometry after tracking loss');
  frame.detectedMeshes.clear(); frame.detectedPlanes.add(plane); located = true;
  surfaces.updateXR(frame, {});
  assert(surfaces.source === 'plane fallback' && surfaces.records.has(plane), 'Planes work when room meshes are unavailable');
  const planeRecord = surfaces.records.get(plane);
  located = false; surfaces.updateXR(frame, {});
  assert(!planeRecord.group.visible && !planeRecord.collider.isEnabled(), 'Lost plane pose disables rendering and physics');
  located = true; surfaces.updateXR(frame, {});
  assert(planeRecord.group.visible && planeRecord.collider.isEnabled(), 'Relocalization restores rendering and physics');
  frame.detectedPlanes.clear(); surfaces.updateXR(frame, {});
  assert(surfaces.records.size === 0 && physics.world.colliders.len() === 0, 'Removed surfaces release their colliders');
  physics.world.free();

  for (const mode of ['relight', 'solid', 'scan', 'hidden']) {
    lab.state.mode = mode; lab.syncStyle(); lab.renderer.render(lab.scene, lab.camera);
    assert(lab.surfaces.mode === mode, `Render mode: ${mode}`);
  }
  lab.state.mode = 'relight'; lab.syncStyle();
  document.getElementById('pin').click();
  assert(lab.state.pinned, 'Desktop pin button changes light state');
  document.querySelector('[data-color="2"]').click();
  assert(lab.state.color === 2, 'Desktop palette changes light color');
  document.getElementById('throw').click();
  assert(lab.physics.balls.length === 1, 'Launch button creates a dynamic ball');
  for (let i = 0; i < 40; i++) lab.shoot();
  assert(lab.physics.balls.length === 32, 'Ball population stays bounded');
  document.getElementById('clear').click();
  assert(lab.physics.balls.length === 0, 'Clear button removes dynamic bodies');
  lab.state.pinned = false; lab.state.color = 0; lab.syncStyle();
  lab.menu.draw({ source: 'test', count: 1, triangles: 2, message: 'Test room' });
  lab.menu.mesh.visible = true;
  lab.menu.mesh.position.set(0, 1.5, -1); lab.menu.mesh.quaternion.identity(); lab.menu.mesh.updateMatrixWorld(true);
  // Center of the first menu button in canvas coordinates, mapped to the plane.
  const target = new THREE.Vector3((210 / 800 - 0.5) * 0.8, (0.5 - 278 / 840) * 0.84, 0).applyMatrix4(lab.menu.mesh.matrixWorld);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 1.5, 0), target.clone().sub(new THREE.Vector3(0, 1.5, 0)).normalize());
  assert(lab.menu.select(ray) && lab.state.mode === 'solid', 'XR menu ray selects a button and dispatches its action');
  lab.menu.mesh.visible = false; lab.state.mode = 'relight'; lab.syncStyle();
  const tear = new Tear(new THREE.Scene());
  const eye = new THREE.Vector3(0, 1.6, 0);
  const input = (x, held = true) => ({ position: new THREE.Vector3(x, 1.4, -0.5), held });
  tear.gesture(input(-0.1), input(0.1), eye);
  tear.gesture(input(-0.15), input(0.15), eye);
  tear.gesture(input(-0.15, false), input(0.15, false), eye);
  for (let i = 0; i < 100; i++) tear.update(0.02, eye);
  assert(!tear.inMesh && tear.progress === 0, 'Small tear cancels on release');
  tear.gesture(input(-0.1), input(0.1), eye);
  tear.gesture(input(-0.3), input(0.3), eye);
  tear.gesture(input(-0.3, false), input(0.3, false), eye);
  for (let i = 0; i < 100; i++) tear.update(0.02, eye);
  assert(tear.inMesh && tear.progress === 0, 'Wide tear completes Reality to Mesh');
  tear.gesture(input(-0.1), input(0.1), eye);
  tear.gesture(input(-0.3), input(0.3), eye);
  tear.gesture(input(-0.3, false), input(0.3, false), eye);
  for (let i = 0; i < 100; i++) tear.update(0.02, eye);
  assert(!tear.inMesh, 'Second wide tear completes Mesh to Reality');
  tear.gesture(input(-0.1), input(0.1), eye);
  tear.gesture(input(-0.3), input(0.3), eye);
  tear.gesture(null, input(0.3), eye);
  for (let i = 0; i < 100; i++) tear.update(0.02, eye);
  assert(!tear.inMesh, 'Lost hand tracking cancels instead of completing a tear');
  tear.reset(); tear.gesture(input(-0.5), input(0.5), eye);
  assert(!tear.dragging, 'Hands already far apart cannot accidentally start a tear');

  const hand = new Map([['thumb-tip', 'thumb'], ['index-finger-tip', 'index']]);
  const source = { hand, handedness: 'left' };
  let gap = 0.02;
  const handFrame = { getJointPose: joint => ({ radius: 0.008, transform: { position: { x: joint === 'thumb' ? 0 : gap, y: 1.4, z: -0.5 } } }) };
  const tracked = new HandInput(new THREE.Scene(), tear.uniforms);
  assert(tracked.sample(handFrame, {}, [source], [], true).left.held, 'Close fingertips register a pinch');
  gap = 0.032;
  assert(tracked.sample(handFrame, {}, [source], [], true).left.held, 'Pinch hysteresis tolerates small tracking noise');
  gap = 0.05;
  assert(!tracked.sample(handFrame, {}, [source], [], true).left.held, 'Open fingers release a pinch');
  gap = 0.02;
  assert(!tracked.sample(handFrame, {}, [source], [{ userData: { source, menuConsumed: true } }], true).left.held,
    'Pinching the menu does not also start a tear');

  lab.state.mode = 'tear'; lab.syncStyle();
  const viewEye = lab.camera.getWorldPosition(new THREE.Vector3());
  lab.tear.update(0, viewEye);
  const oldBackground = lab.scene.background;
  const oldAlpha = lab.renderer.getClearAlpha();
  lab.scene.background = null; lab.renderer.setClearAlpha(0);
  lab.surfaces.material.uniforms.tearDesktop.value = 0;
  const targetBuffer = new THREE.WebGLRenderTarget(64, 64);
  const pixels = new Uint8Array(64 * 64 * 4);
  const alphaCount = () => {
    lab.renderer.setRenderTarget(targetBuffer); lab.renderer.render(lab.scene, lab.camera);
    lab.renderer.readRenderTargetPixels(targetBuffer, 0, 0, 64, 64, pixels);
    let count = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 127) count++;
    return count;
  };
  assert(alphaCount() === 0, 'Reality endpoint preserves passthrough alpha across the framebuffer');
  lab.tear.uniforms.tearBase.value = 1;
  assert(alphaCount() === 4096, 'Mesh endpoint covers the whole view, including gaps in the room scan');
  lab.tear.uniforms.tearBase.value = 0;
  lab.tear.toggle(lab.camera); lab.tear.animation = null; lab.tear.uniforms.tearProgress.value = 0.18;
  const entering = alphaCount();
  assert(entering > 0 && entering < 4096, 'Partial tear exposes mesh only inside the opening');
  lab.tear.uniforms.tearBase.value = 1;
  const leaving = alphaCount();
  assert(leaving > 0 && leaving < 4096, 'Reverse tear exposes passthrough inside the mesh world');
  // Compile and render the instanced hand shader as well as the room shaders.
  lab.hands.sample(handFrame, {}, [source], [], true); alphaCount(); lab.hands.hide();
  lab.renderer.setRenderTarget(null); targetBuffer.dispose();
  lab.scene.background = oldBackground; lab.renderer.setClearAlpha(oldAlpha);
  lab.state.mode = 'relight'; lab.syncStyle(); lab.tear.update(0, viewEye);
  return passed;
}
