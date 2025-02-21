import * as THREE from 'three';
// NO Skypack for Rapier! Load the pre-built files directly.
// import * as RAPIER from 'https://cdn.skypack.dev/@dimforge/rapier3d'; // <-- REMOVE THIS

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { XRButton } from 'three/addons/webxr/XRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

THREE.ColorManagement.enabled = false; // TODO: Consider enabling color management.

let container;
let camera, scene, renderer;
let controller1, controller2;
let controllerGrip1, controllerGrip2;
let raycaster;
const intersected = [];
const tempMatrix = new THREE.Matrix4();
let controls, group;
let world; // Physics world
const objectMap = new Map();

// --- Rapier Initialization (Modified) ---
let RAPIER = null; // Global variable to hold the Rapier module


async function initRapier() {
  // Use jsDelivr to load the pre-built WASM and JS files *directly*.
  // https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.min.js
  const rapierModule = await import("https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.min.js"); //Updated Path
  await rapierModule.default.init(); // Updated init
  RAPIER = rapierModule; // Assign to the global variable
  console.log("Rapier initialized");
  init();  // Call the rest of your initialization *after* Rapier is ready
  animate();
}

async function init() {
    container = document.createElement('div');
    document.body.appendChild(container);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x808080);

    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 10);
    camera.position.set(0, 1.6, 3);

    controls = new OrbitControls(camera, container);
    controls.target.set(0, 1.6, 0);
    controls.update();

    // --- Physics Setup ---
    // Now that RAPIER is initialized, create the world.
    world = new RAPIER.default.World({ x: 0.0, y: -9.81, z: 0.0 });

    const floorGeometry = new THREE.PlaneGeometry(6, 6);
    const floorMaterial = new THREE.ShadowMaterial({ opacity: 0.25, blending: THREE.CustomBlending, transparent: false });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    let floorCollider = RAPIER.default.ColliderDesc.cuboid(3, 0.1, 3);
    world.createCollider(floorCollider); // No rigid body needed for static floor

    scene.add(new THREE.HemisphereLight(0x808080, 0x606060));

    const light = new THREE.DirectionalLight(0xffffff);
    light.position.set(0, 6, 0);
    light.castShadow = true;
    light.shadow.camera.top = 3;
    light.shadow.camera.bottom = -3;
    light.shadow.camera.right = 3;
    light.shadow.camera.left = -3;
    light.shadow.mapSize.set(4096, 4096);
    scene.add(light);

    group = new THREE.Group();
    scene.add(group);

    const geometries = [
        new THREE.BoxGeometry(0.2, 0.2, 0.2)
        /*,
        new THREE.ConeGeometry(0.2, 0.2, 64),
        new THREE.CylinderGeometry(0.2, 0.2, 0.2, 64),
        new THREE.IcosahedronGeometry(0.2, 8),
        new THREE.TorusGeometry(0.2, 0.04, 64, 32)*/
    ];

    for (let i = 0; i < 50; i++) {
        const geometry = geometries[Math.floor(Math.random() * geometries.length)];
        const material = new THREE.MeshStandardMaterial({
            color: Math.random() * 0xffffff,
            roughness: 0.5, // Reduced roughness for a bit more bounciness/sliding
            metalness: 0.1
        });

        const object = new THREE.Mesh(geometry, material);
        object.position.x = Math.random() * 4 - 2;
        object.position.y = Math.random() * 2 + 2;
        object.position.z = Math.random() * 4 - 2;
        object.rotation.x = Math.random() * 2 * Math.PI;
        object.rotation.y = Math.random() * 2 * Math.PI;
        object.rotation.z = Math.random() * 2 * Math.PI;
        object.scale.setScalar(Math.random() + 0.5);
        object.castShadow = true;
        object.receiveShadow = true;

        // --- Physics (Rigid Body and Collider) ---
        let rigidBodyDesc;
        let colliderDesc;

        if (geometry instanceof THREE.BoxGeometry) {
            rigidBodyDesc = RAPIER.default.RigidBodyDesc.dynamic().setTranslation(object.position.x, object.position.y, object.position.z);
            colliderDesc = RAPIER.default.ColliderDesc.cuboid(object.scale.x * 0.1, object.scale.y * 0.1, object.scale.z * 0.1).setRestitution(0.7); // Add restitution for bounciness
        } else if (geometry instanceof THREE.ConeGeometry) {
            rigidBodyDesc = RAPIER.default.RigidBodyDesc.dynamic().setTranslation(object.position.x, object.position.y, object.position.z);
            colliderDesc = RAPIER.default.ColliderDesc.cone(object.scale.y * 0.1, object.scale.x * 0.1).setRestitution(0.7); // Add restitution for bounciness
        } else if (geometry instanceof THREE.CylinderGeometry) {
            rigidBodyDesc = RAPIER.default.RigidBodyDesc.dynamic().setTranslation(object.position.x, object.position.y, object.position.z);
            colliderDesc = RAPIER.default.ColliderDesc.cylinder(object.scale.y * 0.1, object.scale.x * 0.1).setRestitution(0.7); // Add restitution for bounciness
        } else if (geometry instanceof THREE.IcosahedronGeometry) {
            rigidBodyDesc = RAPIER.default.RigidBodyDesc.dynamic().setTranslation(object.position.x, object.position.y, object.position.z);
            colliderDesc = RAPIER.default.ColliderDesc.ball(object.scale.x * 0.2).setRestitution(0.7); // Add restitution for bounciness
        } else if (geometry instanceof THREE.TorusGeometry) {
            rigidBodyDesc = RAPIER.default.RigidBodyDesc.dynamic().setTranslation(object.position.x, object.position.y, object.position.z);
            colliderDesc = RAPIER.default.ColliderDesc.cuboid(object.scale.x * 0.2, object.scale.y * 0.04, object.scale.x * 0.2).setRestitution(0.7); // Add restitution for bounciness
        } else {
            rigidBodyDesc = RAPIER.default.RigidBodyDesc.dynamic().setTranslation(object.position.x, object.position.y, object.position.z);
            colliderDesc = RAPIER.default.ColliderDesc.cuboid(object.scale.x * 0.1, object.scale.y * 0.1, object.scale.z * 0.1).setRestitution(0.7); // Add restitution for bounciness
        }

        let rigidBody = world.createRigidBody(rigidBodyDesc);
        // Set friction here if needed, e.g., .setFriction(0.3) after .setRestitution() in colliderDesc if you want to experiment with friction too.
        let collider = world.createCollider(colliderDesc, rigidBody);
        objectMap.set(object, rigidBody);
        group.add(object);
    }

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.xr.enabled = true;
    container.appendChild(renderer.domElement);

    document.body.appendChild(XRButton.createButton(renderer));

    controller1 = renderer.xr.getController(0);
    controller1.addEventListener('selectstart', onSelectStart);
    controller1.addEventListener('selectend', onSelectEnd);
    scene.add(controller1);

    controller2 = renderer.xr.getController(1);
    controller2.addEventListener('selectstart', onSelectStart);
    controller2.addEventListener('selectend', onSelectEnd);
    scene.add(controller2);

    const controllerModelFactory = new XRControllerModelFactory();

    controllerGrip1 = renderer.xr.getControllerGrip(0);
    controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
    scene.add(controllerGrip1);

    controllerGrip2 = renderer.xr.getControllerGrip(1);
    controllerGrip2.add(controllerModelFactory.createControllerModel(controllerGrip2));
    scene.add(controllerGrip2);

    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const line = new THREE.Line(geometry);
    line.name = 'line';
    line.scale.z = 5;

    controller1.add(line.clone());
    controller2.add(line.clone());

    raycaster = new THREE.Raycaster();
    window.addEventListener('resize', onWindowResize);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Modified onSelectStart and onSelectEnd ---

function onSelectStart(event) {
    const controller = event.target;
    const intersections = getIntersections(controller);

    if (intersections.length > 0) {
        const intersection = intersections[0];
        const object = intersection.object;
        object.material.emissive.b = 1;
        controller.userData.selected = object;
        const rigidBody = objectMap.get(object);

        if (rigidBody) {
            rigidBody.setLinvel(new RAPIER.default.Vector3(0, 0, 0));
            rigidBody.setAngvel(new RAPIER.default.Vector3(0, 0, 0));
            rigidBody.setGravityScale(0, false);
        }
    }
    controller.userData.targetRayMode = event.data.targetRayMode;
}


function onSelectEnd(event) {
    const controller = event.target;

    if (controller.userData.selected !== undefined) {
        const object = controller.userData.selected;
        object.material.emissive.b = 0;
        const rigidBody = objectMap.get(object);

        if (rigidBody) {
            rigidBody.setGravityScale(1, false);

            // Apply impulse based on controller velocity
            const impulseVector = controller.userData.velocity; // Use controller velocity directly
            console.log("Controller Velocity on release:", impulseVector); // *** ADD THIS LINE ***

            if (impulseVector) {
                impulseVector.multiplyScalar(30);  // *** INCREASE MULTIPLIER TO 30 FOR TESTING ***

                rigidBody.applyImpulse(new RAPIER.default.Vector3(impulseVector.x, impulseVector.y, impulseVector.z), true); // Apply impulse
            } else {
                console.log("No controller velocity data available on release."); // Add this line to check if impulseVector is null
            }
        }
        controller.userData.selected = undefined;
    }
}


function getIntersections(controller) {
    controller.updateMatrixWorld();
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
    return raycaster.intersectObjects(group.children, false);
}

function intersectObjects(controller) {
    if (controller.userData.targetRayMode === 'screen') return;
    if (controller.userData.selected !== undefined) return;

    const line = controller.getObjectByName('line');
    const intersections = getIntersections(controller);

    if (intersections.length > 0) {
        const intersection = intersections[0];
        const object = intersection.object;
        object.material.emissive.r = 1;
        intersected.push(object);
        line.scale.z = intersection.distance;
    } else {
        line.scale.z = 5;
    }
}

function cleanIntersected() {
    while (intersected.length) {
        const object = intersected.pop();
        object.material.emissive.r = 0;
    }
}

function animate() {
    renderer.setAnimationLoop(render);
}

function render() {
    cleanIntersected();
    intersectObjects(controller1);
    intersectObjects(controller2);
    world.step();

    if (controller1) {
        controller1.userData.velocity = getControllerVelocity(controller1, 0); //Keep getting velocity
    }
    if (controller2) {
        controller2.userData.velocity = getControllerVelocity(controller2, 1); //Keep getting velocity
    }

    objectMap.forEach((rigidBody, object) => {
        let position = rigidBody.translation();
        let rotation = rigidBody.rotation();
        object.position.set(position.x, position.y, position.z);
        object.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    });

    if (controller1 && controller1.userData.selected) {
        handleGrab(controller1);
    }
    if (controller2 && controller2.userData.selected) {
        handleGrab(controller2);
    }

    renderer.render(scene, camera);
}

function handleGrab(controller) {
    const object = controller.userData.selected;
    const rigidBody = objectMap.get(object);

    if (rigidBody) {
        const targetPosition = new THREE.Vector3();
        controller.getWorldPosition(targetPosition);
        const force = new RAPIER.default.Vector3(
            (targetPosition.x - object.position.x) * 50,
            (targetPosition.y - object.position.y) * 50,
            (targetPosition.z - object.position.z) * 50
        );
        rigidBody.setLinvel(force, true);
    }
}

function getControllerVelocity(controller, index) {
    const gamepad = controller.inputSource?.gamepad;
    if (gamepad && renderer.xr.getFrame()) {
        const pose = renderer.xr.getFrame().getPose(controller.inputSource.targetRaySpace, renderer.xr.getReferenceSpace());
        if (pose && pose.linearVelocity) {
            return pose.linearVelocity;
        }
    }
    return new THREE.Vector3();
}

initRapier(); // Start the Rapier initialization