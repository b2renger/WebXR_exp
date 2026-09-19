import * as THREE from 'three';

// Exercise Spark's real GPU shader and Three's XR ArrayCamera branch. Synthetic
// views/depth cannot validate the Quest driver's depth texture or compositor.
export async function testXrRendering(app) {
  const width=1024, height=512, eyeWidth=512;
  const results = [], check = (ok, label) => { if (!ok) throw new Error(label); results.push(label); };
  const {renderer, spark, scene, camera} = app;
  for(let i=0;i<150 && !spark.activeSplats;i++) await new Promise(resolve=>setTimeout(resolve,100));
  const xr=renderer.xr;
  const saved = { presenting:xr.isPresenting, getCamera:xr.getCamera, getSession:xr.getSession,
    depth:xr.getDepthSensingMesh, autoUpdate:spark.autoUpdate, target:renderer.getRenderTarget(), depthTest:spark.material.depthTest };
  const visibility=new Map();scene.traverse(o=>{ if(o.isMesh || o.isLineSegments){visibility.set(o,o.visible); if(o!==spark)o.visible=false;} });
  // SplatMesh generators remain visible: their geometry comes from Spark.
  for(const it of app.items)it.splat.visible=true;
  const eyes=[-0.032,0.032].map((offset,i)=>{
    const eye=new THREE.PerspectiveCamera(60,1,0.01,200);
    eye.position.copy(camera.position);eye.quaternion.copy(camera.quaternion);
    eye.translateX(offset);eye.updateMatrixWorld(true);eye.viewport=new THREE.Vector4(i*eyeWidth,0,eyeWidth,height);return eye;
  });
  const stereo=new THREE.ArrayCamera(eyes);stereo.position.copy(camera.position);stereo.quaternion.copy(camera.quaternion);stereo.updateMatrixWorld(true);
  stereo.projectionMatrix.copy(camera.projectionMatrix);stereo.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
  const target=new THREE.WebGLRenderTarget(width,height);
  const pixels=new Uint8Array(width*height*4);
  const occluder=new THREE.Mesh(new THREE.PlaneGeometry(10,10),new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:true}));
  occluder.position.copy(camera.position);occluder.quaternion.copy(camera.quaternion);occluder.translateZ(-0.2);scene.add(occluder);
  function renderCounts(){
    renderer.setRenderTarget(target);renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,width,height,pixels);
    const count=[0,0];for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(pixels[(y*width+x)*4+3]>32)count[x<eyeWidth?0:1]++;return count;
  }
  try {
    renderer.setAnimationLoop(null);spark.autoUpdate=false;
    const deadline=performance.now()+10000;
    while(spark.sorting || spark.updateTimeoutId !== -1) { if(performance.now()>deadline)throw new Error('Spark sorting did not settle');renderer.getContext().flush();await new Promise(resolve=>setTimeout(resolve,20)); }
    scene.updateMatrixWorld(true);
    await spark.update({scene,camera});
    xr.isPresenting=true;xr.getCamera=()=>stereo;xr.getSession=()=>({renderState:{}});xr.getDepthSensingMesh=()=>null;
    app.setOcclusion(false);const visible=renderCounts();
    check(visible.every(n=>n>20), 'Both XR eyes must contain splat pixels before testing occlusion');

    app.setOcclusion(true);const hidden=renderCounts();
    check(hidden.every(n=>n===0), 'A foreground depth surface reproduces invisible splats in both eyes');
    app.setOcclusion(false);const restored=renderCounts();
    check(restored.every(n=>n>20), 'Live depth bypass restores actual splat pixels in both eyes without replacing the asset');
  } finally {
    renderer.setRenderTarget(saved.target);target.dispose();scene.remove(occluder);occluder.geometry.dispose();occluder.material.dispose();
    for(const [o,visible]of visibility)o.visible=visible;
    xr.isPresenting=saved.presenting;xr.getCamera=saved.getCamera;xr.getSession=saved.getSession;xr.getDepthSensingMesh=saved.depth;
    spark.autoUpdate=saved.autoUpdate;app.setOcclusion(saved.depthTest);renderer.setAnimationLoop(app.animate);
  }
  return results;
}

