import * as THREE from 'three';
import { XRSessionState } from '../xr-session.js';

export function pose(x = 0, y = 1.6, z = 0, emulatedPosition = false) {
  return { emulatedPosition, transform: { matrix: new THREE.Matrix4().makeTranslation(x,y,z).elements,
    position: { x,y,z }, orientation: { x:0,y:0,z:0,w:1 } } };
}
export function source(handedness = 'right') {
  return { handedness, targetRaySpace: {}, gamepad: { buttons: Array.from({length:6}, () => ({pressed:false})), axes:[0,0,0,0] } };
}
export class Session extends EventTarget {
  visibilityState = 'visible'; inputSources = []; reference = new EventTarget();
  requestReferenceSpace() { return Promise.resolve(this.reference); }
  requestHitTestSource() { return Promise.resolve({cancel(){}}); }
  async end() { this.dispatchEvent(new Event('end')); }
  visibility(state) { this.visibilityState=state; this.dispatchEvent(new Event('visibilitychange')); }
  frame() { return { session:this, getViewerPose:()=>pose(), getPose:()=>pose(), detectedPlanes:new Set(), detectedMeshes:new Set(), getHitTestResults:()=>[] }; }
  input(type, inputSource, frame=this.frame()) { this.dispatchEvent(Object.assign(new Event(type), {inputSource,frame})); }
}

export async function testSessionState(check) {
  const controllers=[new THREE.Group(),new THREE.Group()];
  let suspended=0, resumed=0, ended=0, resets=0, selected=0, lost=0;
  controllers.forEach(c => { c.addEventListener('selectstart',()=>selected++); c.addEventListener('trackinglost',()=>lost++); });
  const state=new XRSessionState(controllers,{suspend:()=>suspended++,resume:()=>resumed++,end:()=>ended++,reset:()=>resets++});
  const session=new Session(), right=source(), left=source('left');
  session.inputSources=[right,left]; state.attach(session); state.bindReference(session.reference);
  let frame=session.frame(); state.update(frame,session.reference);
  check(controllers.every(c=>c.visible) && controllers[0].userData.source===right, 'Controllers already present at entry work without connection events');
  session.inputSources=[left,right]; state.update(frame,session.reference);
  check(controllers[0].userData.source===right, 'Reordering XR input sources preserves controller identity');
  session.input('selectstart',right); session.input('selectstart',right);
  check(selected===1, 'Duplicate trigger starts execute one action');
  session.visibility('hidden');
  check(!state.tracked && controllers.every(c=>!c.visible) && suspended===1, 'Headset removal immediately hides controllers without waiting for a frame');
  const frozen=state.now(); await new Promise(r=>setTimeout(r,15));
  check(state.now()===frozen, 'Anchor deadlines stop advancing during headset suspension');
  session.input('selectstart',right);
  check(selected===1, 'Hidden session cannot activate a trigger');
  session.visibility('visible');
  check(!state.tracked && !controllers[0].visible, 'Visibility alone does not resume stale poses');
  frame.getViewerPose=()=>pose(0,1.6,0,true);state.update(frame,session.reference);
  check(!state.tracked, 'Emulated viewer position cannot resume room rendering');
  frame.getViewerPose=()=>pose(); right.gamepad.buttons[0].pressed=true;
  state.update(frame,session.reference);session.input('selectstart',right);
  check(resumed===2 && selected===1 && controllers[0].visible, 'Fresh pose restores rays but a held trigger is blocked');
  right.gamepad.buttons[0].pressed=false;state.update(frame,session.reference);session.input('selectstart',right);
  check(selected===2, 'Releasing and pressing after resume restores interaction');
  session.input('selectend',right);await Promise.resolve();session.input('selectstart',right);
  check(selected===3,'Repeated press/release cycles work without retaining a trigger latch');
  frame.getPose=()=>null; state.update(frame,session.reference);
  check(controllers.every(c=>!c.visible) && lost>=2 && !state.ready.size, 'Individual pose loss clears controller visibility and activation latches');
  frame.getPose=()=>pose();const newRight=source();session.inputSources=[newRight];state.update(frame,session.reference);
  check(controllers.filter(c=>c.visible).length===1 && controllers.some(c=>c.userData.source===newRight), 'Source replacement without an event reconnects on the next frame');
  frame.getPose=()=>pose(0,0,0,true);state.update(frame,session.reference);
  check(controllers.every(c=>!c.visible), 'Emulated controller poses do not produce floating pointers');
  frame.getPose=()=>pose();state.update(frame,session.reference);session.reference.dispatchEvent(new Event('reset'));
  check(!state.tracked && resets===1, 'Reference reset invalidates tracking before application reset');
  const previousRef=session.reference;
  await session.end(); await Promise.resolve();
  check(!state.session && controllers.every(c=>!c.userData.source) && ended===1, 'Session end clears source ownership and controller visibility');
  const next=new Session();state.attach(next);state.bindReference(next.reference);
  session.visibility('hidden');previousRef.dispatchEvent(new Event('reset'));
  check(state.session===next && resets===1, 'Old session visibility and reference listeners are removed');
  check(state.update(frame,next.reference)===null, 'Frames from an ended session cannot update a new session');
  next.inputSources=[source()];const current=next.frame();state.update(current,next.reference);
  check(state.tracked && controllers.some(c=>c.visible), 'A second session obtains fresh controller poses');
  next.visibility('visible-blurred');next.input('selectstart',next.inputSources[0]);
  check(!state.tracked && controllers.every(c=>!c.visible) && selected===3,'System overlays suspend input and geometry like headset removal');
  state.detach();
}

