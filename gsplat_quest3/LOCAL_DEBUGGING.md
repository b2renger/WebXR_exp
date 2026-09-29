# Run, inspect and record Splat Placer

## PC preview and Quest USB

Open PowerShell in this folder. No build or npm install is required:

```powershell
Set-Location 'C:\Users\b.recoules\Downloads\_projets\WebXR_exp\gsplat_quest3'
node serve.mjs
```

The app is at <http://localhost:8443>, and the PC recording viewer is at <http://localhost:8443/logs.html>. Keep this terminal open. Edit a file and reload the browser to use it. Ctrl+C stops the server. Existing recordings survive restart.

Use Node 22+ (`node --version`). If the port is busy, stop the earlier server or choose a port:

```powershell
$env:PORT = '8445'
node serve.mjs
```

Use the same port everywhere below. `Remove-Item Env:PORT` restores the default for later runs.

Enable developer mode/USB debugging on Quest, connect a USB data cable and accept the debugging prompt in the headset. Install Android Platform Tools if `adb` is unavailable:

```powershell
adb devices
adb reverse tcp:8443 tcp:8443
adb reverse --list
```

`unauthorized` means the headset has not accepted the debugging prompt; an empty list usually indicates the cable, driver, or developer-mode setup. With multiple devices, use `adb -s YOUR_QUEST_SERIAL reverse tcp:8443 tcp:8443`.

Open **http://localhost:8443 in Quest Browser**. The headset's localhost is tunneled to the PC. Loopback supplies the secure context WebXR needs. A plain `http://192.168...` address does not. Enter AR with a controller click, grant requested spatial permissions, aim your head at the floor and trigger when the ring appears.

After reconnecting USB or rebooting the headset, repeat `adb reverse`. To remove the tunnel:

```powershell
adb reverse --remove tcp:8443
```

## Remote DevTools

On desktop Chrome open `chrome://inspect/#devices`, enable **Discover USB devices**, find the Quest Browser tab and select **inspect**. Chrome's [remote debugging guide](https://developer.chrome.com/docs/devtools/remote-debugging/) explains device discovery and inspection.

- Console: enable Preserve log; inspect the first error rather than only the later failures.
- Network: enable Disable cache while DevTools is open, reload, check Three/Spark and asset requests. Paged RAD range requests should return 206; check CORS errors for remote assets.
- Sources: enable pause on uncaught exceptions; put breakpoints in `onTrigger`, `processPlacement`, `makeRoomAnchor`, or the session handlers.
- Performance: capture a short interaction and compare render/worker time. Desktop SwiftShader results are not Quest performance measurements.

Useful Console commands:

```js
SpatialLog.status
SpatialLog.tail().slice(-20)
await SpatialLog.flush()
await SpatialLog.entries()       // current page recording
await SpatialLog.entries(null)   // all retained pages on this origin
SpatialLog.marker('about to test persistent anchor')
__placer.state
__placer.layoutSnapshot()
__placer.renderer.info
__placer.renderer.xr.getSession()?.enabledFeatures
__placer.renderer.xr.hasDepthSensing()
```

The `__placer` hook exposes live objects. `configureTest()` is restricted to `?test` and is for the automated harness. Avoid changing synthetic test state during a real immersive session.

## Recordings

The classic `logger.js` runs before module imports, including on failed startup. The **Recording & logs** panel remains available if Three/Spark fails. It offers current/all-session NDJSON downloads, Sync now, a text marker and a pose-sampling switch. The PC viewer shows recent events, filters warnings/errors and downloads a full session.

Each event has schema version, page session UUID (`sid`), monotonic sequence (`seq`), wall-clock timestamp, elapsed milliseconds, severity, event name and structured data. PC files add `serverReceivedAt`:

```json
{"schema":1,"sid":"example-session-id","seq":42,"time":"2026-09-10T10:00:00.000Z","elapsedMs":2315,"level":"info","event":"splat.squeeze","data":{"args":[{"handedness":"left","down":true}]}}
```

Recording includes:

- Page startup, visibility/connectivity, DOM clicks/changes, canvas pointer events, control keys, selections, placements and deletion.
- AR attempts/features, controller connection and removal, trigger/squeeze events, polled gamepad button transitions, anchor creation/restoration/failure and input cancellation.
- Asset load/fitting/failure, saved layouts, five-second XR heartbeat, WebGL context events, console messages, uncaught errors, promise rejections and failed resources.
- At up to 5 Hz when enabled: viewer and controller transforms, gamepad state, anchor transform and item transforms. These are samples; a brief axis/button movement between polls may be absent. Raw hand joints, passthrough video, depth images and full splat geometry are not recorded.

Use `?poses=0` or uncheck the panel option to disable pose/transform samples. Text typed into ordinary form fields is not recorded as keystrokes; explicit markers, asset URLs and imported/saved layout metadata are recorded. Review exports before sharing them.

### Storage and delivery

Events are queued to IndexedDB (`gsplat-quest3-logs`) in the headset browser. On local loopback, the recorder probes the server and syncs in bounded batches. The server appends to `logs/session-<sid>.ndjson` and syncs the file before acknowledging. Retries are deduplicated by `(sid, seq)`, including after server restart. Unacknowledged events survive reload when IndexedDB succeeds and are retried when the server becomes reachable. No permanent five-failure cutoff remains.

The status panel reports storage/transport mode, events, last-sync pending count, errors and dropped events. Browser storage is finite and may be cleared or evicted by the browser. If storage fails, recording falls back to a **10,000-event memory buffer**, with visible drop accounting; unsaved memory does not survive page close. The live display keeps only a short tail; it is not the complete archive. No browser recorder can guarantee saving the last pending events during a process crash or power loss.

Individual events are capped at 20,000 serialized UTF-8 bytes, with explicit truncation metadata. Arrays/objects/strings have bounded previews. Large payloads and old oversized queued entries cannot block subsequent uploads. This is a bounded diagnostic recording, not a lossless sensor capture or deterministic interaction replay.

The PC files are append-only with no automatic rotation. Download/archive them and monitor available disk space during long sessions. The old `quest-logs.ndjson` is preserved but is no longer written, served, or imported automatically. The former `/log`, `/logs` and `/logs/clear` routes have been replaced by `logs.html` and the durable protocol below.

On GitHub Pages the recorder stays browser-only. `?logging=browser` forces this locally; `?logging=server` explicitly opts a LAN HTTPS origin into server sync. Browser storage is scoped to origin: changing port, hostname or scheme changes its archive. Downloads are the way to move recordings between origins.

### PC files and protocol

```powershell
Get-ChildItem .\logs\session-*.ndjson | Sort-Object LastWriteTime -Descending
Get-Content .\logs\session-YOUR-SID.ndjson -Wait -Tail 20
```

Use the actual filename from the first command. To put recordings outside the source folder, set `LOG_DIR` before starting the server:

```powershell
$env:LOG_DIR = 'C:\Users\b.recoules\Downloads\quest-recordings\gsplat'
node serve.mjs
```

| Endpoint | Purpose |
| --- | --- |
| GET `/__logs/config.json` | Discover `spatial-log-v1` protocol |
| POST `/__logs/events` | Same-origin JSON `{events:[...]}`; durable acknowledgement |
| GET `/__logs/sessions.json` | Session list |
| GET `/__logs/tail?session=SID` | Last 300 events within a 256 KiB tail |
| GET `/__logs/download/SID.ndjson` | Full recording |

The protocol name is shared with spatial_mapping. Each app has its own browser database and default port. The viewer uses text rendering for event data. The server blocks private extensions, dot paths, log/certificate directories and resolved paths outside the project; byte-range static responses support splat streaming.

## Optional trusted LAN HTTPS

Use a certificate trusted by the headset, with a hostname matching the URL. An untrusted certificate-warning bypass is not a dependable WebXR setup. USB loopback or Pages HTTPS is simpler if you do not already have trusted certificates.

```powershell
$env:HOST = '0.0.0.0'
$env:PORT = '8443'
$env:HTTPS_KEY = 'C:\path\outside-published-files\key.pem'
$env:HTTPS_CERT = 'C:\path\outside-published-files\cert.pem'
node serve.mjs
```

Allow the chosen port through the PC firewall only as needed for your development network. Open `https://YOUR_CERTIFICATE_HOSTNAME:8443/?logging=server`. This starts HTTPS on the chosen port; the old automatic 8444 listener is gone. Remove those environment variables when returning to USB HTTP. Never commit certificates or recordings.

## Troubleshooting and a useful capture

| Symptom | What to inspect |
| --- | --- |
| Startup failed | CDN requests, Console's first error; download logs even if the module failed |
| No AR / secure context false | Headset URL must be HTTPS or adb-reversed localhost |
| No ring | Hit-test setup/permissions, viewer tracking, anchor restoration still pending (8 seconds) |
| Asset absent | Loading status, URL/CORS, huge runtime LOD allocation; try bundled `splat.sog` |
| Wrong orientation/size | Captures assume Y-down; inspect `refit()` and `?height=` |
| Saved layout appears in wrong place | Persistent-anchor availability/localization; test fresh placement and inspect anchor events |
| Asset outage | Failed items remain saved; restore connectivity and reload to retry |
| Invalid saved layout | Export raw localStorage text from Console for recovery, then import a valid version 2 layout |
| Occlusion absent | Checkbox applies on next AR entry; verify enabled features and `hasDepthSensing()` |
| Logs retrying | Check server terminal, same port/origin and `/__logs/config.json`; browser archive remains available |
| Pose/fps performance concern | Turn off pose sampling, try one small asset, capture Performance and heartbeat |

For a reproducible headset report: start a new page, add a marker describing the test, enter AR, place one small splat, manipulate with two grips, release, exit/re-enter, then sync and download the session. Include browser/headset versions, asset source, expected behavior and what happened. Test depth with a real object passing between your eyes and the virtual splat; inspect both eyes. Treat hardware checks as pending until performed on Quest.

## Automated checks

```powershell
node tests/smoke.mjs
```

The harness uses real Three/Spark CDN modules and a bundled SOG, synthetic XR lifecycle objects, a real local server and an isolated headless Chrome profile. It checks 72 assertions including corrupt-import preservation, late anchors, pinch saves, load-outage preservation, byte ranges, persistent logging, Unicode limits, offline recovery and blocked-CDN startup. Screenshots are under `.test-output/`. `CHROME_PATH` overrides the Chrome executable; Node 22+ is required for built-in WebSocket. It does not need the manually launched development server.

Reference: [WebXR anchor creation](https://immersive-web.github.io/anchors/#dom-xrframe-createanchor) requires an active frame; placement is therefore queued and revalidated in the animation callback. See [REVIEW.md](REVIEW.md) for review status and hardware limits.


## Placement troubleshooting update — 2026-09-14

Desktop: select a library row, click Place selected asset, then click the ground; Escape cancels. AR: aim your head at the surface ring and press trigger (A/X enters placement for another asset). Pending placement tolerates up to one second without a hit, then reports No surface found. It does not invent a surface when hit testing is unavailable. Placement status is visible in the controller HUD. Inspect splat.placement_requested, splat.placement_commit and splat.placement_blocked records to distinguish tracking, restore, missing hit and asset-load problems.


Placement visibility: a newly created room anchor can take time to produce a pose. The chosen hit-test position stays visible for up to three seconds while waiting; if the anchor never localizes, the app keeps that fixed session position and detaches the persistent handle. A previously tracked anchor still hides the layout on tracking loss. Status distinguishes loading, waiting for geometry, hidden tracking, and loaded at marker; loaded data is not proof of visible splat pixels. The selection box is drawn over depth occlusion so a visible box with missing splats points to a rendering/depth problem. For that case, disable Real-world occlusion before re-entering AR and download the recording.


## Invisible AR splats — visibility mode

Reload and enter AR with Depth occlusion **unchecked** (the new default). Choose the asset shown at the top of the headset HUD: A/X enters placement; stick left/right cycles splats. Right thumbstick click toggles depth testing live. The HUD's Queued count is the number of splats prepared by Spark, not verified visible pixels. If a box remains visible without splats in this mode, download the session: inspect splat.render_diagnostics for activeSplats, instanceCount, sorting, depthTest, depthAvailable and the two eye projection matrices. Sensor depth can only be enabled after it was requested at entry. GPU sorting now explicitly flushes queued work; this is still subject to real-device verification. Screenshots include headset-hud.png and placed-asset.png. The new stereo pixel regression uses a synthetic foreground depth surface, not Quest sensor data.



## Headset lifecycle test sequence

Run the local server and ADB reverse using the instructions above, then reload the page in Quest Browser to load the changed modules. Keep server logging enabled. The code changes are local; GitHub Pages will not change until you publish them.

1. Enter AR with both controllers already awake. Confirm both rays appear. Select a splat, place it, and confirm the actual splat and its marker appear.
2. Exit using the Quest browser AR exit control, then enter again. Repeat three times, including exiting immediately after entry. Confirm rays return and actions do not duplicate.
3. Remove the headset for 10 seconds, put it back on, and wait for tracking. Repeat for at least 30 seconds. Release all controls once, then use the menu/placement again.
4. Repeat while holding a trigger/grip or deflecting a thumbstick. Returning must not fire, place, delete, drag or change values until controls have returned to neutral.
5. Open and close the Quest system menu. Treat visible-blurred as suspended; interactions must not continue behind the overlay.
6. Put the controllers down, switch to hand tracking, then pick them back up. Confirm source replacement, disappearance of untracked rays and return of the current sources. Verify the HUD follows an available tracked controller.
7. Walk around a clearly identifiable floor/wall edge. The placed layout must stay in the room while the camera moves. If tracking is lost, stale imagery should clear instead of sticking to your view.
8. Recenter/change the tracking origin. The old alignment should disappear and the app should ask you to re-anchor on a detected surface.
9. Exit AR and orbit the desktop preview. Confirm the camera, canvas and controls are normal. Cancel/deny another entry attempt and confirm Enter AR remains usable.

After a failure, add a recorder marker describing the step and export/download the recording. Search for these lifecycle events:

| Event | Meaning |
| --- | --- |
| xr.source_bound / xr.source_unbound | Input source ownership, handedness and hand/controller type |
| xr.sources_changed | Runtime source-add/remove notifications; per-frame reconciliation also catches missing notifications |
| xr.visibility | visible, visible-blurred or hidden |
| xr.suspended | Reason interaction and rendering were suspended |
| xr.resumed | Pause duration and number of currently localized input sources |
| xr.reference_reset | The coordinate origin changed; old alignment was invalidated |
| xr.input_ignored | A trigger/grip event was rejected; includes tracking, visibility and neutral-control readiness |

For example, source_bound followed by resumed with zero sources means the source exists but its positional pose is unavailable. input_ignored with ready=false generally means release the controls once. A recurring reference_reset indicates origin changes, not normal head motion. Browser/device logs are still needed for runtime crashes or OS tracking failures that happen outside JavaScript.

Automated verification: run node tests/smoke.mjs. The suite now includes 108 checks, with synthetic session events exercising the actual app entry/exit/frame handlers, plus the existing real SOG and stereo GPU rendering checks. Fixtures cover controller identity/replacement, held-input resume, emulated poses, stale sessions, reference resets, interrupted setup and setup rejection. These do not emulate Meta's native compositor, permission UI or physical room relocalization; the headset sequence above remains necessary.
