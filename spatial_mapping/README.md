# Spatial Mapping

A static Three.js + WebXR room laboratory for Quest 3. No bundler, npm install, framework, or build step. GitHub Pages needs no backend; the optional local Node server also saves debug recordings. Open `index.html` through a web server. Three.js **0.180.0** and Rapier **0.17.3** load as pinned ES modules from jsDelivr; Rapier's compat module embeds its WASM.

**Start here for development:** [Local setup, USB Quest testing, Chrome DevTools, troubleshooting, and full session logs](./LOCAL_DEBUGGING.md).

## Reality → Mesh → Reality

The **Reality ↔ Mesh** surface view recreates the interaction described in the reference video: tear a window into a cyan wireframe room, expand it to fill the view, and tear back to passthrough.

1. Enter AR and obtain a room scan. First inspect alignment in **Scan tint**.
2. Select **Reality ↔ Mesh** in the Surface View dropdown or cycle **View** in the floating menu.
3. Bring both hands within about 35 cm of each other, in front of you. Pinch thumb and index finger on both hands. With controllers, hold both triggers instead.
4. Pull your hands apart while holding the pinches/triggers. The tear stays anchored where it began; the opening grows with your hand separation.
5. Release after the headset menu reports at least **50%** to complete the switch. This takes about 28 cm of additional separation. Release earlier to close the tear.
6. Repeat the same gesture in mesh mode to return to reality.

You can also use **Tear into mesh / Tear back to reality** in the menu, or **Return to reality** for an immediate reset. Those buttons work when hand tracking is unavailable. On desktop the warm-colored synthetic room substitutes for the real camera view; use the tear button to preview the effect.

The session requests optional `hand-tracking`. Joint poses drive pinch detection with separate close/release thresholds to tolerate tracking noise. Inside the mesh region, simple light-blue joint-and-bone hand representations replace the otherwise hidden camera hands. These are procedural approximations, not skinned hand models. Menu selection consumes the pinch/trigger so it does not also start a tear. Hand-pinch thresholds and runtime input behavior still need testing on a Quest.

**How the illusion works:** the same spatial mask drives the room material, its cyan triangle edges, a dark background, and the virtual hands. Outside the mesh region the app preserves transparent pixels, exposing the compositor's passthrough. The mask is evaluated from each eye through one aperture anchored in world coordinates. Once the tear grows large, it expands across the whole view; the reverse transition opens passthrough through the mesh.

There is no texture capture, remeshing, or triangle cutting during the gesture. It is a rendering transition over the existing room reconstruction, with unchanged collider geometry. The dark background also covers gaps in the scan. Balls are cleared and launching is disabled in this mode so they do not interfere with the transition. Tracking/visibility loss and reference-space resets return the effect to reality. This is an expanding aperture rather than a physically simulated sheet or persistent, arbitrarily shaped holes.

The desktop sample has only 120 triangles. A dense reconstruction like the hall in the video depends on the geometry supplied by the Quest scan; plane fallback will be much simpler. The effect does not invent scanned detail.

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
6. Choose **Virtual room** for relighting, or **Reality ↔ Mesh** for the two-hand tear interaction described above.
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
| Trigger elsewhere | Launch a ball in lab views; hold both triggers to tear in Reality ↔ Mesh |
| Right controller motion | Move the virtual light |
| Right grip | Pin/unpin the light in lab views |
| Left grip | Bring the floating menu in front of you |
| Menu | Surface view, color, strength, dimming, wireframe, room capture, clear balls, launch, exit |

Touch controllers support the lighting/physics lab and the tear mode. Optional hand tracking supports two-hand pinches in tear mode; the browser's hand-selection ray can operate the floating menu. The menu is actual 3D geometry, so it works without WebXR DOM Overlay support. Left grip recentering is a controller shortcut; hand-only users can turn back toward the menu.

## What “reconstructing the physical space” means here

There are three related but different sources of geometry:

1. **A headset room model:** the OS scans/sets up the room, and the application consumes the resulting meshes and semantic planes. This is the route implemented here. It is useful immediately for collision, surface placement, occlusion, and visual effects.
2. **Live depth:** a depth image tells you the distance to visible surfaces at that instant. It is useful for dynamic occlusion, but is not already a complete room mesh. Integrating depth observations and their poses over time is a separate reconstruction task.
3. **A textured reconstruction:** accumulate calibrated images and geometry into a persistent mesh, texture atlas, or Gaussian splat. This requires capture, registration, visibility handling, and reconstruction. A splat is an appearance representation; it does not automatically provide a robust collision mesh.

This app implements the first route. It does **not** read a raw depth sensor, run SLAM, fuse a TSDF volume, texture the scan, or rebuild furniture continuously as it moves. A scene mesh may be approximate, incomplete, or stale. Rescan when you move furniture. Mesh density and semantic labels are determined by the runtime.

The supplied text and video description of the [X post](https://x.com/xbh_artist/status/2097636623294890414) identify a Quest 3 / Unity demo, inspired by Lucas Martinic, with a Reality → Mesh → Reality interaction. They do not reveal whether its geometry comes from Meta's scene mesh, another live reconstruction pipeline, or a previously captured scan. Using an aligned room mesh plus a gesture-controlled reveal is an implementation inference, not a claim about the author's exact code.

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
| Reality ↔ Mesh | Tear between passthrough and an opaque cyan wireframe room; repeat to return |

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
| `xr-menu.js` | Canvas-textured in-world menu and controller/hand-selection ray interaction |
| `tear.js` | Shared world-space aperture shaders and reversible gesture/animation state |
| `hand-input.js` | Joint-pose sampling, pinch hysteresis, controller grip positions, procedural hand visuals |
| `serve.mjs` | Optional dependency-free localhost server; not needed by Pages |
| `logger.js` | Early error capture, interaction records, IndexedDB persistence, server retry queue, downloads |
| `logs.html` | Local server's live session viewer, filters, and full-file downloads |
| `LOCAL_DEBUGGING.md` | Detailed local setup, Quest/ADB/DevTools workflow, recording format and recovery |
| `tests/` | Optional browser regression harness; not part of the app startup |

Physics uses a fixed 90 Hz timestep with a capped catch-up interval. Balls use continuous collision detection, expire after 45 seconds, and are capped at 32. Rendering uses a capped pixel ratio and requests foveation; geometry only rebuilds on detected revisions. Large scans still need profiling on the Quest. There is no fallback collision floor in AR: missing scene data should be visible as a problem, not disguised.

An XR session starts with a zero camera offset so the desktop orbit position cannot displace the real room. Origin resets clear balls and release the pinned light. Tracking loss disables room rendering/collision; the last known transforms can still be exported when the session ends. An ordinary session exit returns to the synthetic desktop preview and retains the last captured snapshot in memory. Reloading the page clears that snapshot. OBJ contains geometry only, with no texture, anchors, or automatic import/re-alignment.

Room mesh buffers stay in browser memory unless you explicitly export them. The app automatically records interactions, errors, lifecycle events, and sampled poses in IndexedDB. On the local server those records are also uploaded to the same origin and saved as append-only `logs/session-<id>.ndjson` files. On GitHub Pages they remain in the browser until downloaded. The recorder includes positions/hand joints when pose sampling is enabled, but does not record camera images, audio, or video. See [recording scope and delivery limits](./LOCAL_DEBUGGING.md#4-record-a-reproducible-test-session). Dependency modules are downloaded from jsDelivr.

## Validation and headset checklist

Run the optional checks with Node 22+ and installed Chrome:

```sh
node tests/smoke.mjs
```

On Windows the harness defaults to Chrome in Program Files; set `CHROME_PATH` for another executable. It uses hidden headless Chrome and built-in Node APIs, starts an ephemeral loopback server, loads the actual CDN dependencies, and saves screenshots in ignored `.test-output/`. No package installation is needed.

Checks cover concave plane triangulation, mesh/plane precedence, pose-only updates, triangle collision, geometry replacement, tracking loss/recovery, collider cleanup, OBJ transforms, render modes, ball limits, desktop controls, XR menu ray selection, and mobile overflow. Synthetic XR frame data exercises the mapping lifecycle. Additional tests cover reversible tear gestures, small-tear cancellation, hand-tracking loss, pinch hysteresis, menu input consumption, and GPU framebuffer alpha for reality, mesh, and both partial-transition directions. Logging tests cover durable writes, deduplication across restarts, disk failure, error/interaction capture, IndexedDB reload recovery, browser-only recording, retrying old events, a real blocked-CDN startup failure, and the PC viewer. The latest run passed **76 checks**; preview screenshots include `tear.png`, `mesh.png`, and `logs.png`. **These checks do not validate a real immersive session, Quest permissions, scan quality, tracking alignment, or headset performance.**

On the device, verify:

- Scan tint aligns with the real floor, walls, and furniture. Localized counts should be nonzero.
- A ball hits the same surfaces you see, including the tabletop and walls.
- Light overlay, virtual room, strength, dimming, and pin/unpin work from the floating menu.
- Left grip recovers the menu when you turn away.
- Two-hand pinches and two-controller trigger holds can both enter and leave the mesh world.
- Small tears cancel; wider tears complete on release; a lost hand pose cancels an active tear.
- The opening aligns between the eyes, and virtual hands appear on the mesh side of it.
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
- [WebXR Hand Input specification](https://immersive-web.github.io/webxr-hand-input/) — optional hand tracking and joint poses.
- [Three.js documentation](https://threejs.org/docs/) — WebXRManager, rendering, and materials.

Independent critic review: see [REVIEW.md](REVIEW.md) for findings, fixes and the remaining Quest checks.

Menu interaction: point a controller (or supported hand-selection ray) at a control to highlight it. Press the trigger to cycle its value or run its action; the label updates immediately. Release before pressing again. Each controller has independent hover feedback. Pointing away, tracking loss, and leaving AR clear highlights. Panel padding consumes the press so it cannot launch a ball. Hover transitions are recorded as xr.menu_hover.

