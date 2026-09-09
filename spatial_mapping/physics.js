import * as THREE from 'three';
import RAPIER from 'rapier';

export class Physics {
  static async create(scene) {
    await RAPIER.init();
    return new Physics(scene);
  }
  constructor(scene) {
    this.scene = scene;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 90;
    this.balls = [];
    this.accumulator = 0;
    this.geometry = new THREE.SphereGeometry(0.065, 16, 12);
    this.material = new THREE.MeshStandardMaterial({ color: '#e5ffc7', roughness: 0.35, metalness: 0.15 });
  }
  addSurface(vertices, indices) {
    return this.world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices).setFriction(0.7).setRestitution(0.45));
  }
  removeSurface(collider) { this.world.removeCollider(collider, true); }
  launch(position, direction) {
    if (this.balls.length >= 32) this.removeBall(this.balls.shift());
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z).setCcdEnabled(true));
    this.world.createCollider(RAPIER.ColliderDesc.ball(0.065).setDensity(150)
      .setFriction(0.6).setRestitution(0.65), body);
    body.setLinvel({ x: direction.x * 4, y: direction.y * 4 + 0.7, z: direction.z * 4 }, true);
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.position.copy(position);
    this.scene.add(mesh);
    this.balls.push({ body, mesh, age: 0 });
  }
  removeBall(ball) { this.scene.remove(ball.mesh); this.world.removeRigidBody(ball.body); }
  clear() { this.balls.forEach(ball => this.removeBall(ball)); this.balls = []; this.accumulator = 0; }
  update(dt) {
    this.accumulator += Math.min(dt, 0.05);
    while (this.accumulator >= this.world.timestep) {
      this.world.step();
      this.accumulator -= this.world.timestep;
    }
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const ball = this.balls[i];
      ball.age += dt;
      const p = ball.body.translation();
      if (p.y < -10 || ball.age > 45) { this.removeBall(ball); this.balls.splice(i, 1); continue; }
      ball.mesh.position.copy(p);
      ball.mesh.quaternion.copy(ball.body.rotation());
    }
  }
}
