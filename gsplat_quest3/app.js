
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const params      = new URLSearchParams(location.search);
const requestedHeight = Number(params.get('height') || 1);
const TARGET_H = Number.isFinite(requestedHeight) && requestedHeight > 0 ? requestedHeight : 1; // auto-fit height for new items, metres
const MOVE_SPEED  = 0.6, ROT_SPEED = 1.4, SCALE_RATE = 1.2, DEADZONE = 0.15;
const STORE_KEY   = 'splat-placer-v2:' + location.pathname;

const statusEl = document.getElementById('status');
const say = (msg, isErr) => { statusEl.textContent = msg; statusEl.classList.toggle('err', !!isErr); hud.set(msg); };
const L = (tag, ...args) => SpatialLog.record('splat.' + tag, { args }, tag === 'error' ? 'error' : 'info');

L('boot', 'module loaded, three r' + THREE.REVISION + ', spark 2.1.0');

function downloadFile(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// ---------------------------------------------------------------------------
// Renderer / scene / Spark
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearAlpha(0);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
// Manual XR camera updates: when Quest's depth module reports depthFar=Infinity,
// three propagates it into the camera projections and they go NaN (three#29098).
// We update manually each frame and repair the matrices before rendering.
renderer.xr.cameraAutoUpdate = false;
document.body.appendChild(renderer.domElement);

const scene  = new THREE.Scene();
const DESKTOP_CAM = { fov: 60, near: 0.01, far: 200 };
const camera = new THREE.PerspectiveCamera(DESKTOP_CAM.fov, window.innerWidth / window.innerHeight, DESKTOP_CAM.near, DESKTOP_CAM.far);
camera.position.set(0, 1.6, 2.2);
function resetDesktopCamera() {
  camera.fov = DESKTOP_CAM.fov; camera.zoom = 1;
  camera.near = DESKTOP_CAM.near; camera.far = DESKTOP_CAM.far;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}

// LOD-aware Spark renderer. Budget defaults are platform-aware (500-750K splats
// in WebXR, 2.5M desktop); the cone foveation defaults spend the budget where
// the user is looking — same philosophy as PlayCanvas's gsplat budget balancer.
const spark = new SparkRenderer({ renderer, enableLod: true });
scene.add(spark);

const grid = new THREE.GridHelper(8, 16, 0x3b4a5e, 0x212a35);
grid.material.transparent = true; grid.material.opacity = 0.55;
scene.add(grid);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.5, 0);
controls.enableDamping = true;
controls.update();

// ---------------------------------------------------------------------------
// Scene graph:  anchorNode (room anchor pose) -> per-item rigs
// ---------------------------------------------------------------------------
const anchorNode = new THREE.Group();
scene.add(anchorNode);
let anchorYaw = 0;

// scratch
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _wq = new THREE.Quaternion();
const _ray = new THREE.Ray(), _m4 = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Library of splat sources
// ---------------------------------------------------------------------------
const library = [];   // { name, url, kind: 'sog'|'rad'|'other', blob: bool }
let currentAsset = 0;

function assetKind(url) {
  if (/\.rad(\?|#|$)/i.test(url)) return 'rad';
  if (/\.sog(\?|#|$)/i.test(url)) return 'sog';
  return 'other';
}
function addAsset(url, name) {
  const a = { name: name || url.split('/').pop().split('?')[0] || url,
              url, kind: assetKind(name || url), blob: url.startsWith('blob:') };
  library.push(a);
  currentAsset = library.length - 1;
  renderLibrary();
  return a;
}
function renderLibrary() {
  const el = document.getElementById('library');
  el.innerHTML = '';
  library.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'lib-row' + (i === currentAsset ? ' current' : '');
    const tag = a.kind === 'rad' ? 'streamed' : 'runtime LOD';
    row.innerHTML = '<span class="name"></span><span class="tag">' + tag + '</span>';
    row.querySelector('.name').textContent = a.name;
    row.onclick = () => { currentAsset = i; renderLibrary(); say('Next placement: ' + a.name); };
    el.appendChild(row);
  });
}

addAsset('./splat_heron.sog', 'splat_heron.sog');
addAsset('./splat.sog', 'splat.sog');
addAsset('./splatcaptspirulae.sog', 'splatcaptspirulae.sog');
for (const s of params.getAll('src')) addAsset(s);

document.getElementById('b-addurl').onclick = () => {
  const v = document.getElementById('url-in').value.trim();
  if (v) { addAsset(v); document.getElementById('url-in').value = ''; }
};
document.getElementById('b-addfile').onclick = () => document.getElementById('filepick').click();
document.getElementById('filepick').onchange = (e) => {
  const f = e.target.files[0];
  if (f) addAsset(URL.createObjectURL(f), f.name);   // blob: URLs can't be restored after reload
};

// ---------------------------------------------------------------------------
// Placed items
// ---------------------------------------------------------------------------
let nextId = 1;
const items = [];     // PlacedItem[]
let selected = null;

class PlacedItem {
  constructor(asset, id) {
    this.id = id || crypto.randomUUID();
    this.asset = asset;
    this.baseScale = 1;
    this.loaded = false;

    this.rig = new THREE.Group();       // user transform (pos, yaw, uniform scale), anchor-local
    this.content = new THREE.Group();   // recentring offset
    this.rig.add(this.content);
    anchorNode.add(this.rig);

    // .rad => paged streaming (chunks fetched on demand); anything else => runtime LOD
    // tree. nonLod:true shows the plain splats immediately (and gives us CPU-side
    // data for bounding boxes) while the LOD build runs in a worker, then swaps in.
    const opts = { url: asset.url, fileName: asset.name };
    if (asset.kind === 'rad') opts.paged = true; else { opts.lod = true; opts.nonLod = true; }
    this.splat = new SplatMesh(opts);
    this.content.add(this.splat);

    this.localBounds = new THREE.Box3(
      new THREE.Vector3(-0.25, 0, -0.25), new THREE.Vector3(0.25, 0.5, 0.25));
    this.boxHelper = new THREE.Box3Helper(this.localBounds, 0x2d7ef7);
    this.boxHelper.visible = false;
    this.rig.add(this.boxHelper);

    this._fitTries = 0;
    this._fitted = false;
    L('load', 'loading', asset.name, '(' + (opts.paged ? 'paged/streamed' : 'lod+nonLod') + ')');
    this.ready = this.splat.initialized.then(() => {
      if (this._removed) return;
      this.loaded = true;
      L('load', asset.name, 'initialized, numSplats=' + (this.splat.numSplats || 0));
      this.scheduleRefit();
      saveLayout();
    }).catch((err) => {
      console.error('load failed', asset.url, err);
      say('Failed to load ' + asset.name + ' — ' + (err && err.message || err), true);
      // Keep the failed item's transform/source so a transient outage cannot erase a layout.
      this.failed = true;
      this.boxHelper.visible = true;
      return null;
    });
  }

  // With lod:true / paged sources the bounding box is often degenerate right after
  // `initialized` (splats not yet resident) — retry until real bounds appear.
  scheduleRefit() {
    if (this._removed || this.refit() || this._fitTries++ > 40) return;
    this._fitTimer = setTimeout(() => this.scheduleRefit(), 500);
  }

  refit() {
    // splats are usually authored Y-down: flip 180° about X
    this.splat.quaternion.set(1, 0, 0, 0);
    let box;
    try { box = this.splat.getBoundingBox(true); } catch (e) { box = null; }
    const size = new THREE.Vector3(), ctr = new THREE.Vector3();
    const good = !!(box && !box.isEmpty() && Number.isFinite(box.max.y - box.min.y) && box.max.y - box.min.y >= 1e-4);
    if (good) {
      box.applyMatrix4(_m4.makeRotationFromQuaternion(this.splat.quaternion));
      box.getSize(size); box.getCenter(ctr);
    }
    if (!isFinite(size.y) || size.y < 1e-4) { size.set(TARGET_H, TARGET_H, TARGET_H); ctr.set(0, size.y / 2, 0); }
    this.splat.position.set(-ctr.x, good ? -box.min.y : 0, -ctr.z);
    this.baseScale = TARGET_H / size.y;
    // auto-scale to TARGET_H once, on the first real fit; never stomp a user/restored scale
    if (good && !this._fitted && !this._restored && !this._edited) this.rig.scale.setScalar(this.baseScale);
    if (good && !this._fitted) L('fit', this.asset.name, 'size=' + size.x.toFixed(2) + 'x' + size.y.toFixed(2) + 'x' + size.z.toFixed(2), 'baseScale=' + this.baseScale.toFixed(3));
    if (good) this._fitted = true;
    this.localBounds.setFromCenterAndSize(
      new THREE.Vector3(0, size.y / 2, 0),
      new THREE.Vector3(Math.max(size.x, 0.05), Math.max(size.y, 0.05), Math.max(size.z, 0.05)));
    if (good) saveLayout();
    return good;
  }

  worldBounds(target) {
    anchorNode.updateMatrixWorld(true);
    return target.copy(this.localBounds).applyMatrix4(this.rig.matrixWorld);
  }

  setSelected(on) {
    this.boxHelper.visible = on;
    // gentle tint so it also reads without the box
    this.splat.recolor.setRGB(on ? 0.85 : 1, on ? 0.92 : 1, on ? 1.15 : 1);
  }

  clampScale(s) { return THREE.MathUtils.clamp(s, this.baseScale * 0.02, this.baseScale * 50); }

  remove() {
    if (this._removed) return;
    if (grab.item === this || pinch.item === this) cancelInput('item removed');
    this._removed = true;
    clearTimeout(this._fitTimer);
    this.boxHelper.geometry.dispose(); this.boxHelper.material.dispose();
    L('remove', this.id, this.asset.name);
    anchorNode.remove(this.rig);
    this.splat.dispose();
    const i = items.indexOf(this);
    if (i >= 0) items.splice(i, 1);
    if (selected === this) selectItem(null);
  }

  toJSON() {
    return { id: this.id, src: this.asset.blob ? null : this.asset.url, name: this.asset.name,
             pos: this.rig.position.toArray(), yaw: this.rig.rotation.y, scale: this.rig.scale.x };
  }
}

function selectItem(item) {
  if (selected) selected.setSelected(false);
  selected = item;
  L('selection', item?.id || null);
  if (selected) { selected.setSelected(true); say('Selected: ' + selected.asset.name); }
  hud.refresh();
}

function placeItem(asset, localPos, yawLocal) {
  L('place', { src: asset.url, pos: localPos.toArray(), yaw: yawLocal });
  const it = new PlacedItem(asset);
  it.rig.position.copy(localPos);
  it.rig.rotation.y = yawLocal;
  items.push(it);
  selectItem(it);
  say('Placing ' + asset.name + '…');
  it.ready.then(() => { if (!it._removed) say('Placed ' + asset.name + '.'); }).catch(() => {});
  saveLayout();
  return it;
}

// ---------------------------------------------------------------------------
// Persistence (layout in localStorage, room anchor UUID via Meta persistent anchors)
// ---------------------------------------------------------------------------
let saveTimer = 0;
let persistedAnchorUUID = null;
let invalidStoredLayout = false;
function layoutSnapshot() {
  return { version: 2, anchorUUID: persistedAnchorUUID, items: items.map(i => i.toJSON()).filter(j => j.src) };
}
function saveNow() {
  clearTimeout(saveTimer);
  if (invalidStoredLayout) return;
  try { const snapshot = layoutSnapshot(); localStorage.setItem(STORE_KEY, JSON.stringify(snapshot)); SpatialLog.record('layout.saved', snapshot); }
  catch (error) { SpatialLog.error('layout.save_failed', error); say('Layout could not be saved. Export a copy.', true); }
}
function saveLayout() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); }
function validateLayout(data) {
  if (!data || data.version !== 2 || !Array.isArray(data.items) || data.items.length > 100 ||
      !(data.anchorUUID == null || typeof data.anchorUUID === 'string' && data.anchorUUID.length <= 200)) throw new Error('Expected a version 2 layout with up to 100 items');
  const ids = new Set();
  for (const j of data.items) {
    if (!j || typeof j.id !== 'string' || !j.id || ids.has(j.id) || typeof j.src !== 'string' || !j.src ||
        !['http:', 'https:'].includes(new URL(j.src, location.href).protocol) ||
        typeof j.name !== 'string' || !Array.isArray(j.pos) || j.pos.length !== 3 || !j.pos.every(Number.isFinite) ||
        !Number.isFinite(j.yaw) || !Number.isFinite(j.scale) || j.scale <= 0) throw new Error('Invalid item or duplicate ID');
    ids.add(j.id);
  }
  return data;
}
function loadLayout(data) {
  if (!data) {
    try { const stored = localStorage.getItem(STORE_KEY); if (!stored) return; data = validateLayout(JSON.parse(stored)); }
    catch (error) { invalidStoredLayout = true; SpatialLog.error('layout.restore_failed', error); say('Saved layout is invalid and preserved. Import a valid layout to replace it.', true); return; }
  }
  persistedAnchorUUID = data.anchorUUID || null;
  for (const j of data.items) {
    let asset = library.find(a => a.url === j.src);
    if (!asset) asset = addAsset(j.src, j.name);
    const it = new PlacedItem(asset, j.id);
    it._restored = true;
    it.rig.position.fromArray(j.pos); it.rig.rotation.y = j.yaw; it.rig.scale.setScalar(j.scale);
    items.push(it);
  }
  if (items.length) say('Restored ' + items.length + ' item(s).');
}
function importLayout(text) {
  const data = validateLayout(JSON.parse(text)); // Complete validation before any mutation.
  if (renderer.xr.isPresenting) throw new Error('Exit AR before importing a layout');
  localStorage.setItem(STORE_KEY, JSON.stringify(data)); // A quota failure preserves the working layout.
  invalidStoredLayout = false;
  clearTimeout(saveTimer);
  cancelInput('layout import'); invalidateAnchors();
  [...items].forEach(i => i.remove());
  loadLayout(data);
  saveNow(); L('layout_import', { count: items.length });
}
addEventListener('pagehide', saveNow);

document.getElementById('b-delete').onclick = () => { if (selected) { selected.remove(); saveLayout(); say('Deleted.'); } };
document.getElementById('b-clear').onclick  = () => { [...items].forEach((i) => i.remove()); saveLayout(); say('Cleared.'); };
document.getElementById('b-export').onclick = () => {
  downloadFile('splat-layout.json',
    new Blob([JSON.stringify(layoutSnapshot(), null, 2)], { type: 'application/json' }));
};
document.getElementById('b-import').onclick = () => document.getElementById('importpick').click();
document.getElementById('importpick').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    importLayout(await f.text());
  } catch (err) { say('Import failed: ' + err.message, true); }
};

// ---------------------------------------------------------------------------
// In-headset HUD (dom-overlay isn't available on Quest): small canvas sprite
// above the left controller showing mode + current asset.
// ---------------------------------------------------------------------------
const hud = (() => {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 96;
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.16, 0.03),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }));
  mesh.renderOrder = 1000;
  mesh.position.set(0, 0.04, -0.06);
  mesh.rotation.x = -0.6;
  let lastMsg = '';
  function draw() { try { drawInner(); } catch (e) {} }   // resilient to early calls
  function drawInner() {
    ctx.clearRect(0, 0, 512, 96);
    ctx.fillStyle = 'rgba(10,14,20,0.72)';
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(0, 0, 512, 96, 20); ctx.fill(); }
    else ctx.fillRect(0, 0, 512, 96);
    ctx.fillStyle = '#cfe3ff'; ctx.font = '600 30px sans-serif';
    ctx.fillText((placing ? '▸ PLACE: ' + (library[currentAsset] ? library[currentAsset].name : '') : lastMsg).slice(0, 30), 18, 40);
    ctx.fillStyle = '#8fa2b8'; ctx.font = '24px sans-serif';
    ctx.fillText(placing ? 'stick ◂▸ asset · trigger place' : 'A place · B delete · grip drag', 18, 76);
    tex.needsUpdate = true;
  }
  return { mesh, set(m) { lastMsg = m; draw(); }, refresh: draw };
})();

// ---------------------------------------------------------------------------
// AR button + session (custom: three's ARButton forces 'local' ref space and
// hides the dom-overlay root on exit)
// ---------------------------------------------------------------------------
const arBtn = document.createElement('button');
arBtn.type = 'button'; arBtn.className = 'primary';
arBtn.textContent = 'Checking AR support…'; arBtn.disabled = true;
document.getElementById('ar-btn-slot').appendChild(arBtn);
let arSession = null, startingAR = false;
let requestAttempt = 0;

function arInit(withFloor, withDepth) {
  const init = {
    requiredFeatures: withFloor ? ['hit-test', 'local-floor'] : ['hit-test'],
    optionalFeatures: ['anchors', 'plane-detection', 'hand-tracking'],
  };
  if (withDepth) {
    init.optionalFeatures.push('depth-sensing');
    // gpu-optimized => three r180 auto-renders a depth-priming pass each frame,
    // so real-world geometry occludes the splats. The resulting NaN projection
    // matrices (Quest reports depthFar=Infinity, three#29098) are repaired in
    // the frame loop.
    init.depthSensing = { usagePreference: ['gpu-optimized'], dataFormatPreference: ['float32', 'luminance-alpha', 'unsigned-short'] };
  }
  return init;
}

if (navigator.xr) {
  navigator.xr.isSessionSupported('immersive-ar').then((ok) => {
    L('xr', 'immersive-ar supported =', ok);
    arBtn.disabled = !ok;
    arBtn.textContent = ok ? 'Enter AR' : 'AR not supported on this device';
  }).catch((e) => { L('xr', 'isSessionSupported threw:', e); arBtn.textContent = 'AR unavailable'; });
} else {
  L('xr', 'navigator.xr missing — not a secure context, or no WebXR');
  arBtn.textContent = 'WebXR unavailable (needs HTTPS or adb-reverse localhost)';
}

arBtn.onclick = async () => {
  if (startingAR) return;
  if (arSession) { await arSession.end(); return; }
  startingAR = true; arBtn.disabled = true;
  try {
  const wantDepth = document.getElementById('occl').checked;
  // Short ladder: optional features can't reject a session per spec, so the only
  // realistic retries are the depthSensing dict throwing (strict WebIDL) and
  // 'local-floor' being unsupported. Retries can lose the click's transient
  // user activation on some browsers — a SecurityError means "click again".
  const ladder = [{ floor: true, depth: wantDepth, label: wantDepth ? 'floor+depth' : 'floor' }];
  if (wantDepth) ladder.push({ floor: true, depth: false, label: 'floor' });
  ladder.push({ floor: false, depth: false, label: 'base' });

  let session = null, lastErr = null;
  for (let i = requestAttempt; i < ladder.length; i++) {
    const a = ladder[i];
    try {
      L('xr', 'requestSession attempt:', a.label);
      session = await navigator.xr.requestSession('immersive-ar', arInit(a.floor, a.depth));
      renderer.xr.setReferenceSpaceType(a.floor ? 'local-floor' : 'local');
      L('xr', 'session granted via', a.label, '| refSpace', a.floor ? 'local-floor' : 'local');
      break;
    } catch (e) {
      lastErr = e;
      requestAttempt = e?.name === 'SecurityError' ? i : Math.min(i + 1, ladder.length - 1);
      L('xr', 'attempt', a.label, 'failed:', e);
      if (e && e.name === 'SecurityError') {
        say('AR request needs a fresh click — press Enter AR again.', true);
        return;
      }
    }
  }
  if (!session) { say('Could not start AR: ' + ((lastErr && lastErr.message) || lastErr), true); return; }

  requestAttempt = 0;
  arSession = session;
  L('xr', 'enabledFeatures =', session.enabledFeatures ? [...session.enabledFeatures].join(',') : '(n/a)');
  L('xr', 'environmentBlendMode =', session.environmentBlendMode);
  session.addEventListener('end', () => { arSession = null; arBtn.textContent = 'Enter AR'; });
  try {
    await renderer.xr.setSession(session);
  } catch (e) {
    console.error('renderer.xr.setSession failed:', e);
    await session.end().catch(() => {}); arSession = null;
    say('setSession failed — see Logs.', true);
    return;
  }
  arBtn.textContent = 'Exit AR';
  } finally { startingAR = false; arBtn.disabled = false; }
};

// ---------------------------------------------------------------------------
// Room anchor: ONE anchor for the whole layout, persisted when supported
// ---------------------------------------------------------------------------
const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.055, 0.075, 48).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0.9, depthTest: false }));
reticle.matrixAutoUpdate = false; reticle.visible = false; reticle.renderOrder = 999;
scene.add(reticle);

let hitTestSource = null;
let placing = false;          // reticle live; trigger places currentAsset
let roomAnchored = false;     // anchorNode is pinned to a real pose this session
let restorePending = false;   // persisted anchor restored, waiting for its first pose
let restoreDeadline = 0;      // ms timestamp: give up waiting for the restored pose
let xrAnchor = null;
let lastHitPose = null;       // { position(world), yaw }
const ANCHOR_PROMPT = () => items.length ? 'Trigger on a surface to anchor your layout.' : 'Aim at a surface, trigger to place.';

function setAnchorPose(position, yaw) {
  anchorNode.position.copy(position);
  anchorNode.quaternion.setFromAxisAngle(UP, yaw);
  anchorYaw = yaw;
  roomAnchored = true;
}

let anchorGeneration = 0, pendingPlacement = false, xrTracking = false, lastCancelReason = null;
let trackedSources = new Set();
function invalidateAnchors() {
  anchorGeneration++;
  xrAnchor?.delete?.(); xrAnchor = null;
  restorePending = false;
}
async function makeRoomAnchor(position, yaw, frame) {
  const previousUUID = persistedAnchorUUID;
  // A new pose must never be saved with a handle pointing at the previous pose.
  persistedAnchorUUID = null; saveNow();
  invalidateAnchors();
  const generation = anchorGeneration, session = renderer.xr.getSession();
  const live = () => session && renderer.xr.getSession() === session && anchorGeneration === generation;
  setAnchorPose(position, yaw);
  const refSpace = renderer.xr.getReferenceSpace();
  if (!(frame && refSpace && typeof frame.createAnchor === 'function')) { L('anchor', 'Fixed pose: anchors unavailable'); return; }
  try {
    const q = anchorNode.quaternion;
    const anchor = await frame.createAnchor(new XRRigidTransform(position, q), refSpace);
    if (!live()) { anchor.delete?.(); return; }
    xrAnchor = anchor; L('anchor', 'created');
    if (document.getElementById('persist-anchor').checked && anchor.requestPersistentHandle) {
      const uuid = await anchor.requestPersistentHandle();
      if (!live()) { if (uuid !== persistedAnchorUUID) session.deletePersistentAnchor?.(uuid).catch(() => {}); return; }
      persistedAnchorUUID = uuid; saveNow();
      if (previousUUID && previousUUID !== uuid) session.deletePersistentAnchor?.(previousUUID).catch(error => L('anchor', 'old handle cleanup failed', error));
      L('anchor', 'persistent handle saved', uuid);
    }
  } catch (error) { if (live()) SpatialLog.error('anchor.create_failed', error); }
}
function beginRestore(session) {
  invalidateAnchors();
  const generation = anchorGeneration, uuid = persistedAnchorUUID;
  restorePending = true; restoreDeadline = performance.now() + 8000;
  const live = () => renderer.xr.getSession() === session && generation === anchorGeneration && restorePending && performance.now() <= restoreDeadline;
  session.restorePersistentAnchor(uuid).then(anchor => {
    if (!live()) { anchor.delete?.(); return; }
    xrAnchor = anchor; L('anchor', 'restore accepted', uuid);
  }).catch(error => {
    if (!live()) return;
    restorePending = false; L('anchor', 'restore failed', error); say(ANCHOR_PROMPT());
  });
}
function processPlacement(frame) {
  if (!pendingPlacement) return;
  pendingPlacement = false;
  if (frame && lastHitPose && !restorePending) placeOrAnchorAtHit(frame);
}
async function setupHitTest(session) {
  const live = () => renderer.xr.getSession() === session;
  const viewerSpace = await session.requestReferenceSpace('viewer');
  if (!live()) return false;
  const source = await session.requestHitTestSource({ space: viewerSpace });
  if (!live()) { source.cancel(); return false; }
  hitTestSource?.cancel();
  hitTestSource = source;
  return true;
}

renderer.xr.addEventListener('sessionstart', async () => {
  const session = renderer.xr.getSession();
  const live = () => renderer.xr.getSession() === session;   // guard awaits against session end
  try {
    L('xr', 'sessionstart');
    cancelInput('session start'); invalidateAnchors();
    camera.position.set(0, 0, 0); camera.quaternion.identity(); camera.updateMatrixWorld(true);
    session.addEventListener('visibilitychange', () => { L('visibility', session.visibilityState); if (session.visibilityState !== 'visible') cancelInput('XR hidden'); });
    session.addEventListener('inputsourceschange', e => { L('input_sources', { added: e.added.length, removed: e.removed.length }); if (e.removed.length) cancelInput('source removed'); });
    renderer.xr.getReferenceSpace()?.addEventListener('reset', () => { cancelInput('reference reset'); invalidateAnchors(); roomAnchored = false; anchorNode.visible = false; });
    grid.visible = false;
    controls.enabled = false;
    renderer.xr.setFoveation(0.3);
    roomAnchored = false;
    restorePending = false;
    xrAnchor = null;
    anchorNode.visible = false;
    placing = items.length === 0;   // empty room: jump straight into placing
    hud.refresh();

    // probe depth sensing a moment in (the texture only exists once frames flow)
    setTimeout(() => {
      if (!live()) return;
      try { L('xr', 'hasDepthSensing =', renderer.xr.hasDepthSensing()); } catch (e) { L('xr', 'hasDepthSensing threw:', e); }
    }, 2000);

    // hit-test source FIRST — never starve it behind a slow anchor restore
    try {
      if (!await setupHitTest(session)) return;
      L('xr', 'hit-test source ready');
    } catch (err) {
      if (!live()) return;
      L('xr', 'hit-test unavailable:', err);
      say('Hit-test unavailable — anchoring 1.5 m ahead.', true);
      setAnchorPose(new THREE.Vector3(0, 0, -1.5), 0);
      anchorNode.visible = true;
    }

    // restore the persisted room anchor without blocking; the frame loop flips
    // roomAnchored/visibility when the first pose arrives, or gives up at the
    // deadline. While restorePending, the trigger must NOT re-anchor (it would
    // delete the persisted anchor).
    if (document.getElementById('persist-anchor').checked && persistedAnchorUUID && typeof session.restorePersistentAnchor === 'function') {
      beginRestore(session);
      say('Restoring layout to the room...');
    } else {
      L('anchor', 'no persisted anchor (uuid=' + persistedAnchorUUID + ', api=' +
        (typeof session.restorePersistentAnchor === 'function') + ')');
      say(ANCHOR_PROMPT());
    }
  } catch (err) {
    console.error('sessionstart handler failed:', err);
  }
});

renderer.xr.addEventListener('sessionend', () => {
  L('xr', 'sessionend');
  xrTracking = false; trackedSources.clear();
  cancelInput('session end'); invalidateAnchors();
  hitTestSource?.cancel(); lastHitPose = null;
  camera.position.set(0, 1.6, 2.2); camera.quaternion.identity(); controls.update();
  hitTestSource = null;
  xrAnchor = null;   // keep persistedAnchorUUID: it outlives the session
  grid.visible = true;
  controls.enabled = true;
  anchorNode.visible = true;
  anchorNode.position.set(0, 0, 0);
  anchorNode.quaternion.identity();
  anchorYaw = 0;
  roomAnchored = false;
  restorePending = false;
  reticle.visible = false;
  placing = false;
  // the XR session stomps the user camera's projection (worse with depth
  // sensing, three#29098) — rebuild the desktop projection from one source
  resetDesktopCamera();
  say('Left AR.');
});

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------
const controllers = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  const ray = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ transparent: true, opacity: 0.5 }));
  ray.scale.z = 3;
  c.add(ray);
  c.userData.grabbing = false;
  c.addEventListener('connected', (e) => {
    c.userData.source = e.data;
    c.userData.handedness = e.data && e.data.handedness;
    L('controller_connected', c.userData.handedness);
    if (c.userData.handedness === 'left') c.add(hud.mesh);
  });
  c.addEventListener('disconnected', () => { cancelInput('controller disconnected'); c.userData.source = null; });
  c.addEventListener('select', () => onTrigger(c));
  c.addEventListener('squeezestart', () => onSqueeze(c, true));
  c.addEventListener('squeezeend',   () => onSqueeze(c, false));
  scene.add(c);
  return c;
});

function controllerYaw(c) {
  _v.set(0, 0, -1).applyQuaternion(c.getWorldQuaternion(_wq));
  return Math.atan2(-_v.x, -_v.z);
}

const _bounds = new THREE.Box3();
function itemUnderRay(c) {
  c.getWorldPosition(_v2);
  _v.set(0, 0, -1).applyQuaternion(c.getWorldQuaternion(_wq)).normalize();
  _ray.set(_v2, _v);
  let best = null, bestD = Infinity;
  for (const it of items) {
    it.worldBounds(_bounds);
    if (_bounds.containsPoint(_v2)) return it;
    const hit = _ray.intersectBox(_bounds, new THREE.Vector3());
    if (hit) { const d = hit.distanceTo(_v2); if (d < bestD) { bestD = d; best = it; } }
  }
  return best;
}

function onTrigger(c) {
  L('trigger', c.userData.handedness);
  if (!renderer.xr.isPresenting || !xrTracking || restorePending || !c.visible) return;
  // a surface hit while placing — or before the layout is anchored — consumes the
  // trigger. While a persisted-anchor restore is pending, re-anchoring is blocked:
  // it would delete the persisted anchor mid-restore.
  if (lastHitPose && (placing || (!roomAnchored && !restorePending))) { pendingPlacement = true; return; }
  const it = itemUnderRay(c);
  if (it) selectItem(it);
}

function placeOrAnchorAtHit(frame) {
  const asset = library[currentAsset];
  if (!roomAnchored) {
    // first surface tap this session: the hit becomes the room anchor;
    // a restored layout hangs off it as-is, otherwise place the first item at its origin
    makeRoomAnchor(lastHitPose.position, lastHitPose.yaw, frame);
    anchorNode.visible = true;
    if (placing && items.length === 0 && asset) placeItem(asset, new THREE.Vector3(0, 0, 0), 0);
    else say('Layout anchored here.');
  } else if (placing && asset) {
    anchorNode.updateMatrixWorld(true);
    const local = anchorNode.worldToLocal(lastHitPose.position.clone());
    placeItem(asset, local, lastHitPose.yaw - anchorYaw);
  }
  placing = false;
  reticle.visible = false;
  hud.refresh();
}

// --- grab / pinch ----------------------------------------------------------
const grab  = { active: false, ctrl: null, item: null, offset: new THREE.Vector3(), yaw0: 0, ctrlYaw0: 0 };
const pinch = { active: false, item: null, dist0: 1, scale0: 1, angle0: 0, yaw0: 0 };

function cancelInput(reason) {
  const changed = grab.active || pinch.active || pendingPlacement || keys.size || controllers.some(c => c.userData.grabbing);
  if (grab.active || pinch.active) saveLayout();
  grab.active = pinch.active = false; grab.ctrl = grab.item = pinch.item = null;
  pendingPlacement = false; lastHitPose = null; reticle.visible = false;
  for (const c of controllers) c.userData.grabbing = false;
  keys.clear(); prevButtons = new WeakMap();
  if (changed || lastCancelReason !== reason) L('input_cancel', reason);
  lastCancelReason = reason;
}
function onSqueeze(c, down) {
  L('squeeze', { handedness: c.userData.handedness, down });
  if (pinch.active) saveLayout();
  if (down && (!renderer.xr.isPresenting || !xrTracking || !roomAnchored || !anchorNode.visible || !c.visible)) return;
  if (selected) selected._edited = true;
  c.userData.grabbing = down;
  const held = controllers.filter((x) => x.userData.grabbing);

  if (held.length === 2 && selected) {
    grab.active = false; grab.ctrl = null;
    held[0].getWorldPosition(_v); held[1].getWorldPosition(_v2);
    pinch.active = true; pinch.item = selected;
    pinch.dist0  = Math.max(_v.distanceTo(_v2), 1e-3);
    pinch.scale0 = selected.rig.scale.x;
    pinch.angle0 = Math.atan2(_v2.x - _v.x, _v2.z - _v.z);
    pinch.yaw0   = selected.rig.rotation.y;
    return;
  }
  pinch.active = false;

  if (down && held.length === 1) {
    const it = itemUnderRay(c) || selected;
    if (!it) return;
    selectItem(it);
    grab.active = true; grab.ctrl = c; grab.item = it;
    c.getWorldPosition(_v);
    it.rig.getWorldPosition(_v2);
    grab.offset.copy(_v2).sub(_v);
    grab.yaw0 = anchorYaw + it.rig.rotation.y;
    grab.ctrlYaw0 = controllerYaw(c);
  } else if (!down && grab.ctrl === c) {
    grab.active = false; grab.ctrl = null;
    saveLayout();
  }
}

function setRigWorld(item, worldPos, worldYaw) {
  anchorNode.updateMatrixWorld(true);
  item.rig.position.copy(anchorNode.worldToLocal(worldPos));
  item.rig.rotation.y = worldYaw - anchorYaw;
}

// ---------------------------------------------------------------------------
// Thumbsticks + buttons
// ---------------------------------------------------------------------------
const dz = (v) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));
let prevButtons = new WeakMap();
let assetCycleCooldown = 0;

function handleGamepads(dt) {
  const session = renderer.xr.getSession();
  if (!session || !xrTracking || session.visibilityState !== 'visible') return;
  assetCycleCooldown = Math.max(0, assetCycleCooldown - dt);

  let move = null, rotate = 0, scale = 0;

  for (const src of session.inputSources) {
    if (!trackedSources.has(src)) continue;
    const gp = src.gamepad;
    if (!gp) continue;
    const ax = gp.axes;
    const sx = dz(ax.length > 2 ? ax[2] : (ax[0] || 0));
    const sy = dz(ax.length > 3 ? ax[3] : (ax[1] || 0));

    if (placing) {
      // while placing: either stick left/right cycles the asset
      if (Math.abs(sx) > 0.6 && assetCycleCooldown === 0 && library.length > 1) {
        currentAsset = (currentAsset + (sx > 0 ? 1 : library.length - 1)) % library.length;
        assetCycleCooldown = 0.35;
        renderLibrary(); hud.refresh();
      }
    } else if (src.handedness === 'left') {
      if (sx || sy) move = { x: sx, y: sy };
    } else if (src.handedness === 'right') {
      rotate = -sx; scale = -sy;
    }

    const prev = prevButtons.get(src) || [];
    const pressed = gp.buttons.map((b) => b.pressed);
    pressed.forEach((down, index) => { if (down !== Boolean(prev[index])) L('gamepad_button', { hand: src.handedness, index, down }); });
    if (pressed[4] && !prev[4]) {          // A / X: enter placing mode
      placing = !placing;
      say(placing ? 'Aim at a surface, trigger to place.' : 'Placement cancelled.');
      hud.refresh();
    }
    if (pressed[5] && !prev[5]) {          // B / Y: delete selected
      if (selected) { selected.remove(); saveLayout(); say('Deleted.'); }
    }
    prevButtons.set(src, pressed);
  }

  if (!selected || placing || !roomAnchored || !anchorNode.visible) return;
  if (move || rotate || scale) selected._edited = true;
  const rig = selected.rig;

  if (move) {
    const q = camera.quaternion;
    const headYaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    const hs = Math.sin(headYaw), hc = Math.cos(headYaw);
    // Stick forward is negative Z. Rotate with the head, then apply the actual
    // inverse room orientation to express that world delta in anchor-local axes.
    _v.set(move.x, 0, move.y).applyAxisAngle(UP, headYaw).multiplyScalar(MOVE_SPEED * dt);
    rig.position.add(_v.applyQuaternion(_wq.copy(anchorNode.quaternion).invert()));
    saveLayout();
  }
  if (rotate) { rig.rotation.y += rotate * ROT_SPEED * dt; saveLayout(); }
  if (scale)  { rig.scale.setScalar(selected.clampScale(rig.scale.x * Math.exp(scale * SCALE_RATE * dt))); saveLayout(); }
}

// ---------------------------------------------------------------------------
// Desktop input
// ---------------------------------------------------------------------------
const keys = new Set();
const typingInField = () => {
  const ae = document.activeElement;
  return !!(ae && ae.tagName === 'INPUT' && (ae.type === 'text' || ae.type === 'search'));
};
addEventListener('keydown', (e) => {
  if (!typingInField() && !e.repeat) L('key_down', e.key);
  keys.add(e.key.toLowerCase());
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !typingInField()) {
    selected.remove(); saveLayout(); say('Deleted.');
  }
});
addEventListener('keyup', (e) => { keys.delete(e.key.toLowerCase()); if (!typingInField()) L('key_up', e.key); });
addEventListener('blur', () => cancelInput('window blur'));
document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelInput('page hidden'); saveNow(); } });

function handleKeys(dt) {
  if (renderer.xr.isPresenting || !selected || typingInField()) return;
  const rig = selected.rig;
  let mx = 0, mz = 0;
  if (['a','d','w','s','q','e','+','=','-','_'].some(k => keys.has(k))) selected._edited = true;
  if (keys.has('a')) mx -= 1;
  if (keys.has('d')) mx += 1;
  if (keys.has('w')) mz -= 1;
  if (keys.has('s')) mz += 1;
  if (mx || mz) { rig.position.x += mx * MOVE_SPEED * dt; rig.position.z += mz * MOVE_SPEED * dt; saveLayout(); }
  if (keys.has('q')) { rig.rotation.y += ROT_SPEED * dt; saveLayout(); }
  if (keys.has('e')) { rig.rotation.y -= ROT_SPEED * dt; saveLayout(); }
  const up = keys.has('+') || keys.has('=');
  const dn = keys.has('-') || keys.has('_');
  if (up || dn) { rig.scale.setScalar(selected.clampScale(rig.scale.x * Math.exp((up ? 1 : -1) * SCALE_RATE * dt))); saveLayout(); }
}

const groundPlane = new THREE.Plane(UP, 0);
const pointerRay = new THREE.Raycaster();
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (renderer.xr.isPresenting || e.button !== 0) return;
  const nx = (e.clientX / innerWidth) * 2 - 1, ny = -(e.clientY / innerHeight) * 2 + 1;
  pointerRay.setFromCamera(new THREE.Vector2(nx, ny), camera);
  if (e.shiftKey) {                                   // shift-click: place on ground
    const hit = new THREE.Vector3();
    if (pointerRay.ray.intersectPlane(groundPlane, hit) && library[currentAsset]) {
      anchorNode.updateMatrixWorld(true);
      placeItem(library[currentAsset], anchorNode.worldToLocal(hit), 0);
    }
    return;
  }
  // plain click: select
  _ray.copy(pointerRay.ray);
  let best = null, bestD = Infinity;
  for (const it of items) {
    it.worldBounds(_bounds);
    const hit = _ray.intersectBox(_bounds, new THREE.Vector3());
    if (hit) { const d = hit.distanceTo(_ray.origin); if (d < bestD) { bestD = d; best = it; } }
  }
  if (best) selectItem(best);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let lastSample = 0;
let nanFixLogged = false;
let hb = { frames: 0, last: 0 };   // heartbeat: fps + state every 5s while presenting

function animate(time, frame) {

  const dt = Math.min(clock.getDelta(), 0.1);
  const refSpace = renderer.xr.getReferenceSpace();

  if (renderer.xr.isPresenting) {
    // Manual camera update (cameraAutoUpdate=false), then repair the NaN that
    // three's stereo-union projection gets when Quest reports depthFar=Infinity
    // (three#29098) — Spark's sort/LOD and frustum culling read these matrices.
    // Only the depth column ([10]/[14]) goes NaN; the union frustum shape is
    // valid, so patch just those two elements from a per-view matrix (which is
    // a finite infinite-far form straight from WebXR).
    renderer.xr.updateCamera(camera);
    const xrCam = renderer.xr.getCamera();
    const pe = xrCam.projectionMatrix.elements;
    if (!isFinite(pe[10]) || !isFinite(pe[14])) {
      const src = xrCam.cameras.length ? xrCam.cameras[0].projectionMatrix.elements : null;
      if (src && isFinite(src[10]) && isFinite(src[14])) { pe[10] = src[10]; pe[14] = src[14]; }
      else { pe[10] = -1; pe[14] = -0.2; }   // infinite-far form with near≈0.1
      xrCam.projectionMatrixInverse.copy(xrCam.projectionMatrix).invert();
      camera.projectionMatrix.copy(xrCam.projectionMatrix);
      camera.projectionMatrixInverse.copy(xrCam.projectionMatrixInverse);
      if (!nanFixLogged) { nanFixLogged = true; L('fix', 'repaired NaN depth column in union projection (three#29098)'); }
    }

    const session = renderer.xr.getSession();
    xrTracking = Boolean(frame && refSpace && frame.getViewerPose(refSpace) && session.visibilityState === 'visible');
    trackedSources = new Set(xrTracking ? Array.from(session.inputSources).filter(src => frame.getPose(src.targetRaySpace, refSpace)) : []);
    if (!xrTracking) { cancelInput('tracking unavailable'); anchorNode.visible = false; }
    else if (roomAnchored && !xrAnchor) anchorNode.visible = true;
    if ((grab.active || pinch.active) && controllers.some(c => c.userData.grabbing && (!c.visible || !c.userData.source || !frame.getPose(c.userData.source.targetRaySpace, refSpace)))) cancelInput('controller tracking unavailable');

    // persisted-anchor restore that never localizes: stop waiting at the deadline
    if (restorePending && !roomAnchored && performance.now() > restoreDeadline) {
      invalidateAnchors();
      L('anchor', 'restored anchor never localized within 8s');
      say('Saved anchor not found here — trigger on a surface to re-anchor.');
    }

    hb.frames++;
    if (time - hb.last > 5000) {
      if (hb.last) L('hb', 'fps=' + (hb.frames / ((time - hb.last) / 1000)).toFixed(1),
        'items=' + items.length, 'anchored=' + roomAnchored, 'placing=' + placing,
        'splats=' + items.map((i) => i.splat.numSplats || 0).join('/'));
      hb.last = time; hb.frames = 0;
    }
  }

  // keep the room anchor glued to its real pose
  if (xrTracking && frame && xrAnchor && refSpace) {
    const pose = frame.getPose(xrAnchor.anchorSpace, refSpace);
    if (!pose) { anchorNode.visible = false; cancelInput('anchor tracking unavailable'); }
    if (pose) {
      anchorNode.visible = true;
      const p = pose.transform.position, o = pose.transform.orientation;
      anchorNode.position.set(p.x, p.y, p.z);
      anchorNode.quaternion.set(o.x, o.y, o.z, o.w);
      _v.set(0, 0, -1).applyQuaternion(anchorNode.quaternion);
      anchorYaw = Math.atan2(-_v.x, -_v.z);
      if (!roomAnchored) {
        roomAnchored = true;
        anchorNode.visible = true;
        if (restorePending) {
          restorePending = false;
          L('anchor', 'restored anchor localized');
          say('Layout restored to the room.');
        }
        hud.refresh();
      }
    }
  }

  // hit-test reticle (visible while placing, or before the room is anchored —
  // but not while a persisted-anchor restore is still pending)
  if (xrTracking && frame && hitTestSource && refSpace) {
    const wantReticle = !restorePending && (placing || !roomAnchored);
    lastHitPose = null; reticle.visible = false;
    const hits = frame.getHitTestResults(hitTestSource);
    if (hits.length && wantReticle) {
      const pose = hits[0].getPose(refSpace);
      if (pose) {
        reticle.matrix.fromArray(pose.transform.matrix);
        const p = pose.transform.position;
        camera.getWorldPosition(_v);
        lastHitPose = { position: new THREE.Vector3(p.x, p.y, p.z),
                        yaw: Math.atan2(_v.x - p.x, _v.z - p.z) };
        reticle.visible = true;
      }
    } else {
      reticle.visible = false;
      if (!hits.length) lastHitPose = null;
    }
  }

  if (xrTracking) processPlacement(frame);

  // manipulation
  if (xrTracking && renderer.xr.isPresenting && pinch.active && pinch.item && !pinch.item._removed) {
    const held = controllers.filter((x) => x.userData.grabbing);
    if (held.length === 2) {
      held[0].getWorldPosition(_v); held[1].getWorldPosition(_v2);
      const d = Math.max(_v.distanceTo(_v2), 1e-3);
      pinch.item.rig.scale.setScalar(pinch.item.clampScale(pinch.scale0 * (d / pinch.dist0)));
      pinch.item.rig.rotation.y = pinch.yaw0 + (Math.atan2(_v2.x - _v.x, _v2.z - _v.z) - pinch.angle0);
    } else { pinch.active = false; saveLayout(); }
  } else if (xrTracking && renderer.xr.isPresenting && grab.active && grab.ctrl && grab.item && !grab.item._removed) {
    const dYaw = controllerYaw(grab.ctrl) - grab.ctrlYaw0;
    grab.ctrl.getWorldPosition(_v);
    const off = grab.offset.clone().applyAxisAngle(UP, dYaw);
    setRigWorld(grab.item, _v.add(off), grab.yaw0 + dYaw);
  } else {
    handleGamepads(dt);
    handleKeys(dt);
  }

  if (SpatialLog.motion && time - lastSample >= 200) {
    lastSample = time;
    SpatialLog.record('xr.pose_sample', { presenting: renderer.xr.isPresenting, camera: camera.position.toArray(), orientation: camera.quaternion.toArray(),
      anchor: anchorNode.matrix.toArray(), items: items.map(i => i.toJSON()),
      controllers: controllers.map(c => ({ hand: c.userData.handedness, visible: c.visible, position: c.position.toArray(), orientation: c.quaternion.toArray(), grabbing: c.userData.grabbing })),
      gamepads: Array.from(renderer.xr.getSession()?.inputSources || [], s => ({ hand: s.handedness, axes: s.gamepad?.axes, buttons: s.gamepad?.buttons.map(b => ({ pressed: b.pressed, value: b.value })) })) });
  }
  if (!renderer.xr.isPresenting) controls.update();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadLayout();
if (!items.length && !invalidStoredLayout) say('Add splats to the library, then place them (AR: trigger on a surface, desktop: shift-click).');

renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); cancelInput('WebGL context lost'); SpatialLog.record('webgl.context_lost', {}, 'error'); say('Graphics context lost. Reload if it does not recover.', true); });
renderer.domElement.addEventListener('webglcontextrestored', () => L('webgl_context_restored'));
document.body.dataset.ready = 'true';
L('ready', { items: items.length });
// Debug hooks expose the real implementation for console use and regressions.
window.__placer = { items, library, get selected() { return selected; }, keys, renderer, camera, controllers, anchorNode,
  placeItem, selectItem, onSqueeze, onTrigger, processPlacement, makeRoomAnchor, beginRestore, invalidateAnchors,
  cancelInput, importLayout, validateLayout, layoutSnapshot, saveNow, grab, pinch, animate, handleGamepads, handleKeys, setupHitTest,
  get state() { return { xrAnchor, anchorGeneration, persistedAnchorUUID, restorePending, roomAnchored, pendingPlacement, hitTestSource }; },
  configureTest(values) { if (!params.has('test')) throw new Error('Test mode required');
    if ('lastHitPose' in values) lastHitPose = values.lastHitPose;
    if ('placing' in values) placing = values.placing;
    if ('roomAnchored' in values) roomAnchored = values.roomAnchored;
    if ('persistedAnchorUUID' in values) persistedAnchorUUID = values.persistedAnchorUUID;
    if ('restoreDeadline' in values) restoreDeadline = values.restoreDeadline;
    if ('xrTracking' in values) xrTracking = values.xrTracking;
    if ('trackedSources' in values) trackedSources = values.trackedSources;
    if ('hitTestSource' in values) hitTestSource = values.hitTestSource;
  }
};
