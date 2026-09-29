import * as THREE from 'three';
import { testSessionState, Session, source, pose } from './xr-fixtures.js';

export async function run(app) {
  const results=[];const check=(ok,name)=>{if(!ok)throw Error(name);results.push(name);};
  await testSessionState(check);
  app.renderer.setAnimationLoop(null);
  const xr=app.renderer.xr, original={setSession:xr.setSession,getSession:xr.getSession,getReferenceSpace:xr.getReferenceSpace,updateCamera:xr.updateCamera,isPresenting:xr.isPresenting};
  const oldRender=app.renderer.render,oldClear=app.renderer.clear;let cleared=0;
  app.renderer.render=()=>{};app.renderer.clear=()=>cleared++;
  const descriptor=Object.getOwnPropertyDescriptor(navigator,'xr');
  let active, finish;
  const desktop={position:app.camera.position.clone(),fov:app.camera.fov,far:app.camera.far};
  Object.defineProperty(navigator,'xr',{configurable:true,value:{requestSession:async()=>active}});
  xr.getSession=()=>active;xr.getReferenceSpace=()=>active.reference;xr.updateCamera=()=>{};
  xr.setSession=async()=>{xr.isPresenting=true;xr.dispatchEvent({type:'sessionstart'});};
  document.getElementById('persist-anchor').checked=false;
  const enter=async()=>{active=new Session();active.inputSources=[source()];await app.arBtn.onclick();await Promise.resolve();await Promise.resolve();};
  try {
    await enter();const frame=active.frame();app.animate(1,frame);
    check(app.controllers.some(c=>c.visible) && app.xrState.tracked,'Splat session entry reconciles controllers and fresh tracking');
    app.configureTest({roomAnchored:true});app.anchorNode.visible=true;
    app.grab.active=true;app.grab.ctrl=app.controllers[0];app.controllers[0].userData.grabbing=true;
    active.visibility('hidden');
    check(!app.anchorNode.visible && !app.grab.active && !app.hud.mesh.visible,'Splat suspension immediately hides the layout and cancels manipulation');
    app.animate(9,frame);check(cleared>0,'Untracked splat frames clear stale rendered imagery');
    app.onTrigger(app.controllers[0]);
    check(!app.state.pendingPlacement,'Trigger cannot queue a placement while the headset is removed');
    active.visibility('visible');const src=active.inputSources[0];src.gamepad.buttons[4].pressed=true;
    const placing=app.state.placing;app.animate(17,frame);
    check(app.anchorNode.visible && app.state.placing===placing,'Resume restores a fixed room pose without toggling placement from a held button');
    src.gamepad.buttons[4].pressed=false;app.animate(33,frame);src.gamepad.buttons[4].pressed=true;app.animate(49,frame);
    check(app.state.placing!==placing,'A released and re-pressed gamepad button works after resume');
    src.gamepad.buttons[4].pressed=false;app.animate(65,frame);
    frame.getViewerPose=()=>pose(0,0,0,true);app.animate(81,frame);
    check(!app.anchorNode.visible && !app.xrState.tracked,'Emulated headset position hides the splat instead of moving it with the viewer');
    frame.getViewerPose=()=>pose();app.animate(97,frame);
    active.reference.dispatchEvent(new Event('reset'));await Promise.resolve();await Promise.resolve();
    check(!app.state.roomAnchored && !app.anchorNode.visible && !app.state.pendingPlacement,'Reference reset requires new localization instead of reusing a fixed pose');
    app.animate(113,frame);
    check(!app.anchorNode.visible,'Fresh viewer tracking alone cannot resurrect a layout at an obsolete origin');
    // Resume does not spend the anchor localization budget while the headset is off.
    app.configureTest({persistedAnchorUUID:'lifecycle-fixture'});
    let completeRestore;active.restorePersistentAnchor=()=>new Promise(r=>completeRestore=r);
    app.beginRestore(active);active.visibility('hidden');const before=app.xrState.now();
    await new Promise(r=>setTimeout(r,20));
    const anchor={anchorSpace:{},delete(){this.deleted=true;}};completeRestore(anchor);await Promise.resolve();
    check(app.xrState.now()===before && app.state.xrAnchor===anchor,'Anchor restore completing during suspension is retained without spending its timeout');
    active.visibility('visible');app.animate(129,frame);
    check(app.anchorNode.visible && app.state.roomAnchored && !app.state.restorePending,'Restored anchor becomes visible only after a fresh anchor pose');
    app.camera.fov=110;app.camera.far=Infinity;await active.end();await Promise.resolve();xr.isPresenting=false;
    check(!app.xrState.session && app.camera.position.distanceTo(desktop.position)<1e-6 && app.camera.fov===desktop.fov && app.camera.far===desktop.far && app.controls.enabled,'Splat exit restores desktop camera and releases input listeners');
    active=new Session();xr.setSession=()=>new Promise(r=>finish=r);
    const pending=app.arBtn.onclick();await Promise.resolve();await active.end();finish();await pending;
    check(!app.xrState.session && app.arBtn.textContent==='Enter AR','Splat entry interrupted by session end cannot leave a false Exit AR button');
    xr.setSession=async()=>{xr.isPresenting=true;xr.dispatchEvent({type:'sessionstart'});};
    await enter();app.animate(145,active.frame());
    check(app.xrState.tracked && app.controllers.some(c=>c.visible),'Splat re-entry works after interrupted renderer initialization');
    await active.end();await Promise.resolve();
    xr.isPresenting=false;active=new Session();xr.setSession=async()=>{throw Error('SPATIAL_LOG_TEST_renderer_setup_failure');};
    await app.arBtn.onclick();
    check(!app.xrState.session && app.controls.enabled && app.arBtn.textContent==='Enter AR','Splat renderer setup rejection cleans up and restores the entry button');
    let requests=0;navigator.xr.requestSession=async()=>{requests++;throw new DOMException('SPATIAL_LOG_TEST_denied','NotAllowedError');};
    await app.arBtn.onclick();
    check(requests===1 && !app.xrState.session && !app.arBtn.disabled,'Denied AR entry does not retry permission prompts and leaves entry usable');
    app.configureTest({persistedAnchorUUID:null});app.saveNow();
  } finally {
    if(app.xrState.session)await active.end();
    Object.assign(xr,original);app.renderer.render=oldRender;app.renderer.clear=oldClear;
    if(descriptor)Object.defineProperty(navigator,'xr',descriptor);else delete navigator.xr;
    document.getElementById('persist-anchor').checked=true;
    app.renderer.setAnimationLoop(app.animate);
  }
  return results;
}
