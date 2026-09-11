# Quest 3 Splat Placer

A static Three.js + Spark prototype for placing existing Gaussian splat captures in a room. It loads SOG/SPZ/PLY and other Spark-supported files, supports multiple objects, controller manipulation, optional depth occlusion, and a room anchor for the layout. No npm install or build step is needed.

This project displays **existing captures**. It does not reconstruct a room, generate splats from Quest cameras, create collision meshes, or relight the physical room. See the adjacent `spatial_mapping` experiment for room mesh visualization, triangle collisions and synthetic lighting. The original gsplat brief is not present in the review conversation; this scope comes from the existing app and its controls.

## Start locally

Install Node.js 22 or later and run in this directory:

```powershell
node serve.mjs
```

Open <http://localhost:8443>. Shift-click the ground to place the selected library asset. Use a small capture first; runtime LOD construction can take time and memory. The included `splat.sog` is the smallest sample.

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

The latest automated run passed **54 checks**. These checks use synthetic XR objects for lifecycle tests; they do not certify real Quest tracking, stereo rendering, permissions, anchor localization, or frame rate. See [REVIEW.md](REVIEW.md) for the critic review and remaining hardware checks.

## Files

`index.html` contains UI and the import map; `app.js` contains rendering and interaction logic. `logger.js` starts recording before modules load. `serve.mjs` is the optional local server and durable log receiver; `logs.html` is its PC viewer. Both XR experiments intentionally carry standalone copies of the same recorder/protocol/server implementation so either directory can be hosted alone.

