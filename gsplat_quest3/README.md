# Quest 3 Splat Placer

A static Three.js + Spark prototype for placing existing Gaussian splat captures in a room. It loads SOG/SPZ/PLY and other Spark-supported files, supports multiple objects, controller manipulation, optional depth occlusion, and a room anchor for the layout. No npm install or build step is needed.

This project displays **existing captures**. It does not reconstruct a room, generate splats from Quest cameras, create collision meshes, or relight the physical room. See the adjacent `spatial_mapping` experiment for room mesh visualization, triangle collisions and synthetic lighting. The original gsplat brief is not present in the review conversation; this scope comes from the existing app and its controls.

## Start locally

Install Node.js 22 or later and run in this directory:

```powershell
node serve.mjs
```

Open <http://localhost:8443>. Choose a library asset, click **Place selected asset**, then click the ground. Shift-click the ground is also supported; selecting a library row alone does not place anything. Use a small capture first; runtime LOD construction can take time and memory. The included `splat.sog` is the smallest sample.

For Quest USB development, enable Quest developer mode and USB debugging, connect a data cable, accept the headset's debugging prompt, then run:

```powershell
adb devices
adb reverse tcp:8443 tcp:8443
```

Open `http://localhost:8443` in **Quest Browser**. Enter AR, aim the headset at a surface until a ring appears, then press a controller trigger. The ring follows a viewer-space hit test, so surface placement is aimed with your head; controller rays select existing objects.

The server defaults to loopback. Ordinary HTTP on a LAN IP is not a secure context for WebXR. See [LOCAL_DEBUGGING.md](LOCAL_DEBUGGING.md) for trusted HTTPS, Chrome inspection, logs, and troubleshooting.

## Controls

| Input | Action |
| --- | --- |
| Desktop shift-click ground | Place the current asset |
| Desktop click a bounding box | Select an object |
| WASD / Q,E / +,- | Move / rotate / scale selected object |
| Delete or Backspace | Delete selected object, except when typing in a text field |
| AR trigger while placing | Place at the surface ring or anchor a restored layout |
| AR trigger on an existing object | Select using its bounding box |
| Left thumbstick | Move selected object |
| Right thumbstick | Rotate horizontally, scale vertically |
| Grip / two grips | Drag / scale and rotate |
| A or X | Toggle placement |
| Stick left/right while placing | Cycle the asset library |
| B or Y | Delete selected object |

Manipulation pauses when viewer, controller, or anchor tracking is unavailable. The room hides while its tracked anchor has no pose. Failed asset loads retain an item/placeholder and its saved transform; reload to retry, or explicitly delete it.

## Layout and room persistence

Transforms and URL sources save to localStorage under `splat-placer-v2:<pathname>`. **Export** reads current transforms immediately. **Import** validates a version 2 JSON layout before replacing anything and requires exiting AR. File-picker assets use temporary blob URLs and cannot be restored or included in a reusable layout: put the file on your host and use its URL for persistence.

When supported and enabled, one persistent room anchor aligns the entire layout between AR sessions. Restoration waits up to eight seconds; if localization fails, place the layout again. A new placement detaches the old handle from the saved layout even if creating the replacement anchor fails. Unchecking persistence skips restore and new persistent-handle creation; it does not erase the OS's saved anchor handles. Fixed-pose fallback lasts only for that session.

Spatial access, persistent anchors, and depth availability depend on the browser/runtime and permissions. Leaving AR returns to the desktop scene. Layouts and recordings belong to the browser origin; localhost, LAN HTTPS, and GitHub Pages do not share their storage.

## Rendering and limitations

- Three.js is pinned to r180 and Spark to 2.1.0 in `index.html`. CDN access is needed for startup.
- Non-RAD sources use `lod: true, nonLod: true`. They download and build LOD at runtime; they are not progressive network streaming. [Spark's LOD documentation](https://sparkjs.dev/docs/lod-getting-started/) describes precomputation.
- Paged `.rad` assets use `paged: true`. The local server supports HTTP byte ranges; remote hosts must support the ranges and CORS needed by Spark. Verify `206 Partial Content` responses in DevTools. The bundled samples are SOG, so real RAD page loading remains a manual check.
- New objects fit to one metre tall by default (`?height=2` changes this). An actual user transform prevents a later loading callback from changing its scale. Captures are assumed Y-down and flipped around X; differently authored captures need an orientation adjustment in `PlacedItem.refit()`.
- Selection uses bounding boxes, not individual visible splats. There is no collision simulation.
- Depth occlusion requests GPU depth on AR entry; Three.js renders its depth prepass when the feature is granted. The projection repair handles nonfinite depth columns observed with infinite far planes. Correct stereo occlusion and sorting still need Quest validation. Depth here is not fused into a mesh, exported, or recorded as images.

## GitHub Pages

Publish this folder as ordinary static files in your Pages source. No server process, bundler, or package installation runs on Pages. Include `index.html`, `app.js`, `logger.js`, and your asset files. Relative paths work in a repository subdirectory. Large assets must fit your host's limits; externally hosted files need CORS. Confirm Range support before using paged RAD on any host.

The recorder works in browser-only mode on Pages. Download recordings from the Logs panel; PC sync and `logs.html` require the optional local server. Do not publish `logs/`, certificates, or old `quest-logs.ndjson` recordings. `.gitignore` excludes new local artifacts but cannot untrack existing files.

## Verification

```powershell
node tests/smoke.mjs
```

The runner needs Node 22+, installed Chrome (`CHROME_PATH` can override its path), and CDN access. It starts an isolated server and browser profile. It loads a real bundled SOG with Spark and tests layout preservation, active-frame anchor creation, late async results, pinch saving, input cancellation, byte-range serving, durable log sync, offline recovery, and failed startup recording. Screenshots go to `.test-output/`. Temporary profiles and log directories are retained under the OS temp directory for inspection.

The latest automated run passed **72 checks**. These checks use synthetic XR objects for lifecycle tests; they do not certify real Quest tracking, stereo rendering, permissions, anchor localization, or frame rate. See [REVIEW.md](REVIEW.md) for the critic review and remaining hardware checks.

## Files

`index.html` contains UI and the import map; `app.js` contains rendering and interaction logic. `logger.js` starts recording before modules load. `serve.mjs` is the optional local server and durable log receiver; `logs.html` is its PC viewer. Both XR experiments intentionally carry standalone copies of the same recorder/protocol/server implementation so either directory can be hosted alone.



Placement visibility: a newly created room anchor can take time to produce a pose. The chosen hit-test position stays visible for up to three seconds while waiting; if the anchor never localizes, the app keeps that fixed session position and detaches the persistent handle. A previously tracked anchor still hides the layout on tracking loss. Status distinguishes loading, waiting for geometry, hidden tracking, and loaded at marker; loaded data is not proof of visible splat pixels. The selection box is drawn over depth occlusion so a visible box with missing splats points to a rendering/depth problem. For that case, disable Real-world occlusion before re-entering AR and download the recording.


## AR splat visibility and selection — 2026-09-15

Depth occlusion is now **off by default**: the app omits the optional depth request and Spark ignores the depth buffer. This keeps physical-depth occlusion from hiding splats while diagnosing AR visibility. It also means objects will be visible through real furniture/walls. Enable Depth occlusion before AR entry to request sensor access. Press the **right thumbstick inward** to switch splat depth testing on/off live; if depth was not requested at entry, the HUD explains that enabling sensor access requires re-entry.

The headset HUD again shows the current asset name and index. In placement mode (**A/X**), move either thumbstick left/right to choose a splat and trigger at the ring to place it. Previous splat / Next splat buttons and clickable library rows work on desktop. The HUD follows the left controller, or the tracked right controller when the left is unavailable.

Spark 2.1.0 generation and asynchronous sort readback now explicitly flush GPU commands. The HUD's Queued count is Spark's active splat count, not a count of visible pixels. Five-second splat.render_diagnostics events include loaded/queued/instanced counts, sorting state, render sizes, depth state, and both eye projections. Zero queued splats suggests loading/LOD/sorting; a nonzero queue with no visible splats points toward rendering/camera/depth.

The 72-check suite now includes **real Spark GPU pixel checks through a synthetic stereo XR camera**: both eyes draw splats, an opaque depth surface hides them, and depth bypass restores them without replacing the asset. It also tests desktop and thumbstick asset selection and the live depth switch. This is stronger than the prior load/placement checks, but does not validate the Quest driver or its depth texture. Depth remains experimental. See [Spark renderer options](https://sparkjs.dev/docs/spark-renderer/) and the pinned [Three.js depth implementation](https://github.com/mrdoob/three.js/blob/r180/src/renderers/webxr/WebXRDepthSensing.js).



## Session lifecycle and tracking recovery (September 2026)

Controllers are reconciled from the current session's input sources on entry and every XR frame, including hand/controller replacement. Rays use current target-ray poses in the same reference space as the room. They no longer depend on Three's cached controller connection events.

Removing the headset, opening a system overlay, or losing positional tracking immediately cancels held interactions. Content is hidden and any remaining XR frames are cleared to passthrough. Returning to visible is insufficient: a fresh, non-emulated viewer pose is required. Release buttons, triggers and thumbsticks once after recovery before using them. The controller HUD returns with a localized input source. Anchor localization timeouts pause while tracking is suspended.

An ordinary pause preserves room placement and waits for fresh anchor poses. A reference-space reset invalidates the old alignment and asks you to trigger on a surface to re-anchor the saved layout. It does not guess a position in front of you if surface detection fails.

Session entry is serialized. Exit removes session/reference listeners and restores the desktop camera pose, projection, canvas size and controls. Late initialization results cannot revive an ended session. See [the headset lifecycle test sequence](LOCAL_DEBUGGING.md#headset-lifecycle-test-sequence) for hardware validation.
