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
    const labels = this.actions.map(action => action.label(state));
    const signature = JSON.stringify([state, labels]);
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
      c.fillStyle = '#294535'; c.fillRect(rect.x, rect.y, rect.w, rect.h);
      c.fillStyle = '#edffe8'; c.font = '25px sans-serif'; c.fillText(label, rect.x + 18, rect.y + 46);
      return rect;
    });
    c.fillStyle = '#acc8b3'; c.font = '22px sans-serif';
    c.fillText(state.tear ? 'Pinch both hands / hold triggers, pull apart' : 'Trigger: menu or launch ball', 35, 752);
    c.fillText(state.tear ? 'Release to finish | Left grip: move menu' : 'Right grip: pin light | Left grip: move menu', 35, 790);
    this.texture.needsUpdate = true;
  }
  select(raycaster) {
    if (!this.mesh.visible) return false;
    const hit = raycaster.intersectObject(this.mesh)[0];
    if (!hit) return false;
    const x = hit.uv.x * 800, y = (1 - hit.uv.y) * 840;
    const index = this.rects?.findIndex(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) ?? -1;
    if (index >= 0) this.actions[index].run();
    return true; // Clicking panel padding must not also shoot a ball.
  }
}
