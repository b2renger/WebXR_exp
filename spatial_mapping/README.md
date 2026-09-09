# Spatial Mapping

A static Three.js + WebXR room laboratory for Quest 3. No bundler, npm install, framework, backend, or build step. Open `index.html` through a web server. Three.js **0.180.0** and Rapier **0.17.3** load as pinned ES modules from jsDelivr; Rapier's compat module embeds its WASM.

## Try it

### GitHub Pages

Commit this directory to `b2renger/WebXR_exp` and publish the repository root with GitHub Pages. The expected URL, **once those files are published**, is:

`https://b2renger.github.io/WebXR_exp/spatial_mapping/`

All app paths are relative, so repository subpaths work. No Actions build is needed; Pages can serve directly from your selected branch. This prototype has not been committed, pushed, or deployed by the implementation task.

1. On Quest 3, open the HTTPS URL in the **standalone Meta Quest Browser**.
2. Choose **Enter room in AR** and allow the requested spatial/environment access.
3. Look around for the floating green menu and detected surfaces. If none appear, select **Set up room**. If that does not work, exit AR and run the headset's **Space Setup / room setup** in Settings, then re-enter. Settings names vary with OS version.
4. Choose **Scan tint** to inspect alignment, then **Light overlay**. Move your right controller near the floor, walls, and furniture.
5. Pull a trigger away from the menu to launch a ball. It should bounce on scanned geometry.
6. Choose **Virtual room** to replace scanned surfaces with an opaque, virtually lit material.
7. Choose **Exit AR / keep scan**, then **Download captured room (.obj)** in the browser UI. The export is in meters with surface transforms baked in.

The app requests mesh and plane detection as optional features, so AR can still start if spatial mapping is unavailable. The floating status and Diagnostics explain whether data is arriving. Missing data is never substituted with the synthetic desktop room in AR.

### Local preview

From this directory:

```sh
node serve.mjs
```

Open `http://localhost:8450` on your computer. The synthetic room uses the same surface rendering and triangle collision code as AR. Drag to orbit and scroll to zoom. **Pin light** stops its automatic motion.

For a USB-connected Quest with developer mode and ADB already configured:

```sh
adb reverse tcp:8450 tcp:8450
```

Then open `http://localhost:8450` **inside the Quest browser**. Loopback is treated as a secure context. The optional server binds to loopback; it does not expose a LAN endpoint. A plain `http://192.168…` address would not satisfy WebXR's secure-context requirement. Use Pages HTTPS for untethered testing.

## Headset controls

| Input | Action |
| --- | --- |
| Trigger pointed at a menu button | Activate that button |
| Trigger elsewhere | Launch a ball along the controller ray |
| Right controller motion | Move the virtual light |
| Right grip | Pin/unpin the light in room coordinates |
| Left grip | Bring the floating menu in front of you |
| Menu | Surface view, color, strength, dimming, wireframe, room capture, clear balls, launch, exit |

Touch controllers are the intended input. Hand interactions are not implemented. The menu is actual 3D geometry, so it works without WebXR DOM Overlay support.

## What “reconstructing the physical space” means here

There are three related but different sources of geometry:

1. **A headset room model:** the OS scans/sets up the room, and the application consumes the resulting meshes and semantic planes. This is the route implemented here. It is useful immediately for collision, surface placement, occlusion, and visual effects.
2. **Live depth:** a depth image tells you the distance to visible surfaces at that instant. It is useful for dynamic occlusion, but is not already a complete room mesh. Integrating depth observations and their poses over time is a separate reconstruction task.
3. **A textured reconstruction:** accumulate calibrated images and geometry into a persistent mesh, texture atlas, or Gaussian splat. This requires capture, registration, visibility handling, and reconstruction. A splat is an appearance representation; it does not automatically provide a robust collision mesh.

This app implements the first route. It does **not** read a raw depth sensor, run SLAM, fuse a TSDF volume, texture the scan, or rebuild furniture continuously as it moves. A scene mesh may be approximate, incomplete, or stale. Rescan when you move furniture. Mesh density and semantic labels are determined by the runtime.

The linked [X post](https://x.com/xbh_artist/status/2097636623294890414) was inaccessible during implementation, so this project does not attribute a particular algorithm or framework to its author.

### Data flow

```text
Quest Space Setup / scene model
              |
    WebXR detectedMeshes       (or detectedPlanes fallback)
              |
     local vertices + pose
        /       |         \
  Three.js    Rapier       OBJ snapshot
  surfaces    static      for external tools
  + depth     colliders
        |       |
  lighting    bouncing balls
  overlays
```

The relevant API is small:

```js
const session = await navigator.xr.requestSession('immersive-ar', {
  requiredFeatures: ['local-floor'],
  optionalFeatures: ['mesh-detection', 'plane-detection'],
});

// Inside an active XR animation frame:
for (const mesh of frame.detectedMeshes ?? []) {
  const pose = frame.getPose(mesh.meshSpace, referenceSpace);
  if (!pose) continue;
  // mesh.vertices: Float32Array, XYZ in mesh-local coordinates.
  // mesh.indices: Uint32Array, triangle vertex indices.
  // pose.transform.matrix: mesh-local -> reference-space transform.
}
```

Rebuild vertex/index buffers and colliders when `lastChangedTime` changes. **Update the pose independently on every frame:** a pose change does not change that timestamp. Disable unlocalized surfaces and remove surfaces that leave the detected set. Plane polygons are triangulated in their local XZ coordinates, including concave outlines.

The app prefers localized meshes to planes, avoiding overlapping collision surfaces and double shading. If there are meshes with only partial room coverage, it does not try to fill every gap with semantic planes; that would require spatial overlap analysis.

## Relighting: what works, and the limit

| View | Result |
| --- | --- |
| Light overlay | A translucent, distance- and normal-dependent colored light field over the scanned surfaces; surface dimming controls a dark veil |
| Virtual room | Opaque geometry with neutral material and the synthetic light; hides the real textures on those surfaces |
| Scan tint | Translucent green surface inspection |
| Passthrough + occlusion | No visible room material or wireframe; the room still hides virtual objects behind its geometry |

In every view, the room first writes depth with `colorWrite = false`. The visible material and balls then respect that depth. This provides **static mesh occlusion**, not live depth occlusion of moving hands or people.

For the overlay, the shader estimates a local diffuse contribution from the surface normal, the light direction, and distance falloff. It alpha-composites that color over the compositor's passthrough image. **The real scene is not being physically illuminated, and moving a Three.js light does not directly change passthrough.** The point light affects virtual balls; a corresponding shader affects the room surfaces.

The real image already contains light, shadows, and reflections. Transparent overlays can suggest new illumination, tint, and local darkness, but cannot recover the underlying unlit surface color or remove the original shadows correctly. Virtual room mode gives fuller lighting control because it substitutes the room appearance. This prototype has no cast shadows or light visibility test: its analytic light can affect a surface through another wall.

Useful next steps, in order:

1. **Shadow receiver:** add a `ShadowMaterial` over selected surfaces and a single shadow-casting light. Start with one modest shadow map; test the stereo frame budget on the headset. Consider plane receivers initially to avoid scan self-shadowing artifacts.
2. **Real depth occlusion:** feature-detect WebXR depth sensing separately and use a depth prepass. This addresses moving foreground objects; it does not make room colliders dynamic.
3. **Textured capture:** current Meta Browser supports passthrough camera access, and Meta's IWSDK documents `getUserMedia`-based camera streams. The stream is distinct from the compositor's final stereo passthrough. First investigate available camera calibration, timestamps, and poses, then project frames onto the mesh, reject occluded samples, and bake an atlas. This app does not request camera access.
4. **More convincing relighting:** estimate albedo/roughness and remove baked illumination, or author a virtual duplicate with approximate materials. Texturing alone preserves the original lighting. Add shadowing, light probes, and material-dependent reflections as separate steps.
5. **Persistent alignment:** save the map in a spatial anchor's coordinate system and restore that anchor in a later session, with runtime support checks. Exporting an OBJ in `local-floor` coordinates does not provide cross-session relocalization.
6. **Continuous reconstruction:** study a native implementation that fuses depth into a truncated signed-distance field (TSDF), extracts triangles, and projects camera images onto them. The browser could still be a static viewer for exported GLB/OBJ assets even if a native tool performs capture.

## Architecture

| File | Responsibility |
| --- | --- |
| `index.html`, `style.css` | Static entry point, import map, desktop controls and diagnostics |
| `app.js` | Scene, XR session lifecycle, input, light, desktop preview, exports |
| `surfaces.js` | Mesh/plane lifecycle, transforms, triangulation, depth/lighting materials, sample room, OBJ serialization |
| `physics.js` | Rapier world, fixed triangle colliders, dynamic balls, cleanup |
| `xr-menu.js` | Canvas-textured in-world menu and controller ray interaction |
| `serve.mjs` | Optional dependency-free localhost server; not needed by Pages |
| `tests/` | Optional browser regression harness; not part of the app startup |

Physics uses a fixed 90 Hz timestep with a capped catch-up interval. Balls use continuous collision detection, expire after 45 seconds, and are capped at 32. Rendering uses a capped pixel ratio and requests foveation; geometry only rebuilds on detected revisions. Large scans still need profiling on the Quest. There is no fallback collision floor in AR: missing scene data should be visible as a problem, not disguised.

An XR session starts with a zero camera offset so the desktop orbit position cannot displace the real room. Origin resets clear balls and release the pinned light. Tracking loss disables room rendering/collision; the last known transforms can still be exported when the session ends. An ordinary session exit returns to the synthetic desktop preview and retains the last captured snapshot in memory. Reloading the page clears that snapshot. OBJ contains geometry only, with no texture, anchors, or automatic import/re-alignment.

Room geometry stays in browser memory unless you explicitly download it. The app has no upload or logging endpoint. Its dependency modules are downloaded from jsDelivr.

## Validation and headset checklist

Run the optional checks with Node 22+ and installed Chrome:

```sh
node tests/smoke.mjs
```

On Windows the harness defaults to Chrome in Program Files; set `CHROME_PATH` for another executable. It uses hidden headless Chrome and built-in Node APIs, starts an ephemeral loopback server, loads the actual CDN dependencies, and saves screenshots in ignored `.test-output/`. No package installation is needed.

Checks cover concave plane triangulation, mesh/plane precedence, pose-only updates, triangle collision, geometry replacement, tracking loss/recovery, collider cleanup, OBJ transforms, render modes, ball limits, desktop controls, XR menu ray selection, and mobile overflow. Synthetic XR frame data exercises the mapping lifecycle. **These checks do not validate a real immersive session, Quest permissions, scan quality, tracking alignment, or headset performance.**

On the device, verify:

- Scan tint aligns with the real floor, walls, and furniture. Localized counts should be nonzero.
- A ball hits the same surfaces you see, including the tabletop and walls.
- Light overlay, virtual room, strength, dimming, and pin/unpin work from the floating menu.
- Left grip recovers the menu when you turn away.
- The app behaves clearly when spatial permission is denied or there is no room scan.
- Pause/resume, room capture, tracking loss, exit, and a second AR session work.
- After exit, the downloaded OBJ opens at meter scale in Blender or another mesh tool.

If nothing appears, inspect Diagnostics: `null` means a frame API was not exposed/observed; `0` means the API exposed an empty set. A nonempty set with zero localized surfaces can indicate missing poses. Check spatial permissions, run Space Setup, and re-enter. Room capture is feature-detected and requested at most once per session. The runtime may ignore that request.

## Primary references

Reviewed September 9, 2026. Runtime support should still be checked on your particular headset/browser.

- [WebXR Mesh Detection specification](https://immersive-web.github.io/real-world-meshing/) — vertices, triangle indices, poses, change timestamps.
- [WebXR Plane Detection specification](https://immersive-web.github.io/plane-detection/) — plane polygons and lifecycle.
- [Official immersive-web mesh detection sample](https://immersive-web.github.io/webxr-samples/proposals/mesh-detection.html).
- [Meta: mixed reality in Browser](https://developers.meta.com/horizon/documentation/web/webxr-mixed-reality/) — session setup, planes, and room capture. Its historical camera-pixel restriction predates later camera access support.
- [Meta Browser 40.1 release notes](https://developers.meta.com/horizon/downloads/package/browser/40.1/) — introduction of passthrough camera support.
- [Meta: camera access on the immersive web](https://developers.meta.com/horizon/documentation/iwsdk/guides/13-camera-access/) — MediaDevices streams, permissions, and lifecycle. The concepts are usable without adopting the SDK/build system.
- [Meta: native Passthrough Camera API](https://developers.meta.com/horizon/documentation/unity/unity-pca-overview/) — native camera capture route.
- [QuestRoomScan source](https://github.com/arghyasur1991/QuestRoomScan) — an independent Unity implementation of TSDF fusion, Surface Nets meshing, and passthrough texturing, for studying the more ambitious reconstruction pipeline; not a dependency or verified implementation of the X post.
- [Rapier JavaScript colliders](https://rapier.rs/docs/user_guides/javascript/colliders/) — triangle meshes and dynamic collider shapes.
- [Three.js documentation](https://threejs.org/docs/) — WebXRManager, rendering, and materials.
