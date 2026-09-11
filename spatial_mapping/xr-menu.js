import * as THREE from 'three';

export class XRMenu {
  constructor(actions) {
    this.actions = actions;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 800;
    this.canvas.height = 840;
    this.context = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.84),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    this.mesh.renderOrder = 100;
    this.mesh.visible = false;
    this.lastText = '';
    this.pointers = new Map();
    this.pressed = new Map();
    this.state = null;
  }
  place(camera) {
    const position = camera.getWorldPosition(new THREE.Vector3());
    const rotation = camera.getWorldQuaternion(new THREE.Quaternion());
    const euler = new THREE.Euler().setFromQuaternion(rotation, 'YXZ');
    rotation.setFromEuler(new THREE.Euler(0, euler.y, 0, 'YXZ'));
    this.mesh.position.copy(position).add(new THREE.Vector3(-0.65, -0.12, -1.45).applyQuaternion(rotation));
    this.mesh.lookAt(position);
    this.mesh.updateMatrixWorld(true);
  }
  draw(state) {
    this.state = state;
    const labels = this.actions.map(action => action.label(state));
    const hovered = new Set(this.pointers.values());
    const pressed = new Set(this.pressed.values());
    const signature = JSON.stringify([state, labels, [...hovered], [...pressed]]);
    if (signature === this.lastText) return;
    this.lastText = signature;
    const c = this.context;
    c.fillStyle = '#13231b'; c.fillRect(0, 0, 800, 840);
    c.strokeStyle = '#91bd95'; c.lineWidth = 3; c.strokeRect(2, 2, 796, 836);
    c.fillStyle = '#d1f8ae'; c.font = 'bold 40px sans-serif'; c.fillText('SPATIAL MAPPING', 35, 63);
    c.fillStyle = '#dceadf'; c.font = '24px sans-serif';
    c.fillText(`${state.source}  /  ${state.count} surfaces  /  ${state.triangles} triangles`, 35, 109);
    c.fillStyle = '#a8c5ad'; c.font = '22px sans-serif';
    const words = state.message.split(' ');
    let line = '', y = 150;
    for (const word of words) {
      if (c.measureText(line + word).width > 720) { c.fillText(line, 35, y); line = ''; y += 28; }
      if (y > 207) break;
      line += word + ' ';
    }
    c.fillText(line, 35, y);
    this.rects = labels.map((label, i) => {
      const rect = { x: 30 + (i % 2) * 380, y: 240 + Math.floor(i / 2) * 92, w: 360, h: 76 };
      c.fillStyle = pressed.has(i) ? '#527b35' : hovered.has(i) ? '#416e50' : '#294535'; c.fillRect(rect.x, rect.y, rect.w, rect.h);
      if (hovered.has(i) || pressed.has(i)) {
        c.strokeStyle = pressed.has(i) ? '#ffffff' : '#d1ff94'; c.lineWidth = 5;
        c.strokeRect(rect.x + 3, rect.y + 3, rect.w - 6, rect.h - 6);
      }
      c.fillStyle = '#edffe8'; c.font = '25px sans-serif'; c.fillText(label, rect.x + 18, rect.y + 46);
      return rect;
    });
    c.fillStyle = '#acc8b3'; c.font = '22px sans-serif';
    c.fillText('Point to highlight / press trigger to change', 35, 752);
    c.fillText(state.tear ? 'Release to finish | Left grip: move menu' : 'Right grip: pin light | Left grip: move menu', 35, 790);
    this.texture.needsUpdate = true;
  }
  hitTest(raycaster) {
    if (!this.mesh.visible) return null;
    this.mesh.updateWorldMatrix(true, false);
    const hit = raycaster.intersectObject(this.mesh)[0];
    if (!hit) return null;
    const x = hit.uv.x * 800, y = (1 - hit.uv.y) * 840;
    const index = this.rects?.findIndex(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) ?? -1;
    return { ...hit, index };
  }
  updatePointer(raycaster, pointer = 'default') {
    const hit = raycaster ? this.hitTest(raycaster) : null;
    const previous = this.pointers.get(pointer) ?? -1;
    const index = hit?.index ?? -1;
    if (index < 0) this.pointers.delete(pointer); else this.pointers.set(pointer, index);
    if (previous !== index) {
      globalThis.SpatialLog?.record('xr.menu_hover', { pointer, previous, index });
      this.redraw();
    }
    return hit;
  }
  redraw() { if (this.state) this.draw(this.state); }
  release(pointer = 'default') { this.pressed.delete(pointer); this.redraw(); }
  clearPointer(pointer) { this.updatePointer(null, pointer); this.release(pointer); }
  clearPointers() { for (const pointer of new Set([...this.pointers.keys(), ...this.pressed.keys()])) this.clearPointer(pointer); }
  select(raycaster, pointer = 'default') {
    // One activation per press, even if the pointer moves while held.
    if (this.pressed.has(pointer)) return true;
    const hit = this.updatePointer(raycaster, pointer);
    if (!hit) return false;
    const index = hit.index;
    this.pressed.set(pointer, index);
    if (index >= 0) {
      globalThis.SpatialLog?.record('xr.menu_action', { pointer, index, label: this.actions[index].label(this.state || {}), uv: hit.uv.toArray() });
      try {
        const result = this.actions[index].run();
        if (result?.catch) result.catch(error => globalThis.SpatialLog?.error('xr.menu_action_failed', error, { index }));
      } catch (error) { globalThis.SpatialLog?.error('xr.menu_action_failed', error, { index }); throw error; }
      finally { this.redraw(); }
    } else globalThis.SpatialLog?.record('xr.menu_padding', { uv: hit.uv.toArray() });
    return true; // Clicking panel padding must not also shoot a ball.
  }
}
