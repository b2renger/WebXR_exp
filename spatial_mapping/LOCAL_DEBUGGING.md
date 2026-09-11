# Local development, Quest debugging, and session recordings

This guide uses the actual project folder and the included Node server. There is no build step and no `npm install`. JavaScript changes take effect after reloading the page. Three.js and Rapier are fetched from the pinned CDN URLs, so the headset still needs internet access unless those modules are already cached.

## 1. Start the local server on Windows

Open PowerShell:

```powershell
Set-Location 'C:\Users\b.recoules\Downloads\_projets\WebXR_exp\spatial_mapping'
node --version
node serve.mjs
```

Use Node 22 or newer for the server and test harness. Keep this terminal open. The server prints:

```text
Spatial Mapping: http://localhost:8450
Log viewer:      http://localhost:8450/logs.html
Logs on disk:    ...\spatial_mapping\logs
Quest USB:      adb reverse tcp:8450 tcp:8450
```

On the PC, open:

- **App:** <http://localhost:8450>
- **Live recordings:** <http://localhost:8450/logs.html>

The desktop scene is a synthetic test room. It is useful for testing controls, physics, shaders, exports, and logging. It is not a scan of the computer's surroundings and cannot validate headset tracking.

Do not double-click `index.html` to run it as a `file://` page. ES modules, origin-based storage, and WebXR need an HTTP(S) origin.

**Stopping / restarting:** press `Ctrl+C` in the server terminal. Restart with `node serve.mjs`. Restarting does not delete log files. The server deduplicates retried events against previously saved session data.

**Port already in use:** stop the older server terminal, or choose a different port:

```powershell
$env:PORT = '8452'
node serve.mjs
```

Use the same new port in the browser URL and ADB command. To restore the default in that terminal:

```powershell
Remove-Item Env:PORT
```

## 2. Connect a Quest over USB

Use the standalone Meta Quest Browser in the headset. Quest Link / a PC VR browser is a different runtime and may not expose the same room and passthrough capabilities.

Prerequisites:

- Enable developer mode for the headset through Meta's developer/device setup.
- Install Android Platform Tools, or use the ADB executable supplied by your existing Quest development tools.
- Connect a **data-capable** USB cable.
- Put on the headset and accept the USB debugging authorization for this computer. A file-transfer prompt is not the same as USB debugging authorization.

In a **second PowerShell terminal**, leaving the Node server running:

```powershell
adb version
adb devices -l
adb reverse tcp:8450 tcp:8450
adb reverse --list
```

`adb devices -l` should list your headset with the state `device`.

- `unauthorized`: put on the headset and accept the debugging prompt.
- No device: check the cable, USB port, developer mode, and ADB installation/driver.
- More than one device: target the headset explicitly:

```powershell
adb -s YOUR_QUEST_SERIAL reverse tcp:8450 tcp:8450
```

If `adb` is not in PATH, use its actual executable path. For example, if you installed Android Platform Tools under `C:\Android\platform-tools`:

```powershell
& 'C:\Android\platform-tools\adb.exe' devices -l
& 'C:\Android\platform-tools\adb.exe' reverse tcp:8450 tcp:8450
```

Inside **Meta Quest Browser**, enter this exact address:

```text
http://localhost:8450
```

Here `localhost` means the headset. ADB forwards the headset's port 8450 to the PC's port 8450. Loopback is treated as a secure context, which allows WebXR without managing HTTPS certificates. Enter AR, allow spatial access, and use **Set up room** if the surface count stays zero.

The same tunnel carries log uploads to your PC. In the PC log viewer, each page load appears as a separate session ID. A desktop tab and a Quest tab therefore have different recordings; inspect their `page.start` user agent to tell them apart.

After unplugging/reconnecting, restarting the headset, or restarting ADB, run `adb reverse` again. Check the mapping with `adb reverse --list`. To remove this mapping when finished:

```powershell
adb reverse --remove tcp:8450
```

Meta documents this workflow in [Debug Browser content](https://developers.meta.com/horizon/documentation/web/browser-remote-debugging/).

## 3. Inspect the headset with Chrome DevTools

Keep the headset connected and authorized. Open the app in Quest Browser, then on the PC:

1. Open Chrome and navigate to `chrome://inspect/#devices`.
2. Enable **Discover USB devices**.
3. Find the Quest and the tab whose URL is `http://localhost:8450`.
4. Click **inspect** for that tab.
5. In **Console**, enable **Preserve log**. In **Network**, enable **Preserve log** and, while debugging, **Disable cache**.
6. Reload the Quest tab. Watch the console and network requests before entering AR.

If the tab is missing, verify `adb devices -l`, make sure the browser tab is open in the headset, and check for another authorization prompt. Inspect the Quest tab, not the desktop copy of the page.

Useful console expressions:

```js
// Environment and saved diagnostics:
isSecureContext
document.getElementById('diagnostics').textContent

// Recorder health and the last 300 in-memory events:
SpatialLog.status
SpatialLog.tail()

// Full current-page recording from browser storage:
await SpatialLog.entries()

// All retained pages on this origin, including before a reload:
await SpatialLog.entries(null)

// Add a timestamped observation, then request server synchronization:
SpatialLog.marker('Right-hand pinch failed near the table')
await SpatialLog.flush()

// Export the current page or all retained pages:
await SpatialLog.download()
await SpatialLog.download(true)
```

For code inspection you can add `?test` to the app URL, which exposes the existing development object:

```js
spatialLab.surfaces.stats()
spatialLab.tear.progress
spatialLab.renderer.info
```

The test hook is optional; the recorder is available in normal sessions too.

Use the **Sources** panel to place breakpoints or enable **Pause on exceptions**. A breakpoint pauses the frame loop and may interrupt XR tracking. Re-enter AR if needed after a long pause. For rendering/performance problems, record a short **Performance** trace while reproducing the issue. A useful trace is usually a few seconds around the problem, not a long recording of an idle scene.

Chrome's [remote debugging guide](https://developer.chrome.com/docs/devtools/remote-debugging/) and [local server forwarding guide](https://developer.chrome.com/docs/devtools/remote-debugging/local-server) describe the underlying tools.

## 4. Record a reproducible test session

Recording starts automatically in `logger.js`, a classic script loaded before Three.js, Rapier, app modules, and stylesheets. No Record button is required.

A practical test sequence:

1. Start the Node server and open its log viewer on the PC.
2. Open or reload the app on Quest. Note the new session ID in **Recording & logs** or the PC viewer.
3. Add a marker such as `test 01: fresh room setup` from the page panel or remote console.
4. Enter AR, scan/localize the room, and reproduce the issue once.
5. Add a marker from the remote console immediately when the issue occurs. This works while the headset is in AR; the page's DOM panel is hidden during immersion.
6. Exit AR and leave the tab open for a few seconds. In the Recording panel, choose **Sync to local server** and check for a connected transport and no pending entries at the last sync.
7. Download the full session from the PC viewer, or copy the matching `.ndjson` file from `logs`.

If you need a screen recording as well, record/cast the headset separately using Meta's device tools. This recorder captures structured events and sampled poses; it does **not** record video, audio, passthrough images, or a frame-exact replay.

### What is recorded

| Category | Events/data |
| --- | --- |
| Bootstrap | Page start, user agent, origin/path, viewport, secure context, module load, physics ready, app ready |
| Errors | Console errors/warnings/debug output, uncaught exceptions with stack/location, unhandled promise rejection reasons, resource failures, WebGL context loss, caught XR/capture failures |
| Desktop controls | Button clicks, select/range/checkbox changes, palette choice, canvas pointer press/release, orbit start/end camera positions |
| App actions | Settings before/after, ball launches with origin/direction, mesh export counts, status messages |
| XR lifecycle | Session request, granted features, blend mode, rendering start, visibility, tracking loss/recovery, origin resets, session end |
| Inputs | Sources added/removed, controller select/squeeze start/end, button/touch state transitions, menu button label/index, pinch close/open and tracking loss |
| Tearing | Gesture start and world position, progress changes of at least 0.1, release/commit decision, cancellation, completion, resets |
| Geometry | Added/removed surfaces, labels, triangle/vertex counts, geometry revisions via replacement, localization transitions |
| Motion | Viewer and controller/grip matrices, buttons/axes and light position at up to 5 Hz in AR; hand joints at up to 5 Hz when the tear-mode hand sampler runs |
| Health | Every 5 seconds: estimated frame rate, detected/localized counts, ball count, draw calls, triangle count, geometry/texture counts |
| Annotations | Manual markers and log export requests |

All semantic events above are recorded when they occur; repeated motion is deliberately sampled. Controller movements between samples are not retained. Hand skeleton sampling currently runs in tear mode. Runtime `select`/`squeeze` input events still record in other views when supplied by the browser. Geometry payloads contain counts and labels, not the full scan buffers.

Pose sampling is **on by default**. Turn it off in **Recording & logs**, or start with:

```text
http://localhost:8450/?poses=0
```

This reduces log volume while retaining button, gesture, lifecycle, and error events.

### File format and timestamps

Files contain newline-delimited JSON: one independent JSON event per line.

```json
{"schema":1,"sid":"example-session-id","seq":42,"time":"2026-09-10T10:30:20.123Z","elapsedMs":8234.5,"level":"info","event":"tear.released","data":{"progress":0.73,"complete":true},"serverReceivedAt":"2026-09-10T10:30:20.701Z"}
```

- `sid`: one ID per page load; all AR sessions within that page share it.
- `seq`: increasing sequence number within that page. Use `(sid, seq)` to deduplicate.
- `time`: browser wall-clock UTC timestamp, useful across files.
- `elapsedMs`: monotonic time since recorder startup, useful for timing interactions.
- `serverReceivedAt`: added by the Node server when it writes the event. Offline/retried events may arrive much later than they occurred.
- `level`, `event`, `data`: severity, event name, and structured payload.

Use `seq` to order events within a session even if the headset clock changes. In the viewer, a live tail can show a subset of the session; the download contains the complete file.

### Where the logs live

**In the browser:** IndexedDB database `spatial-mapping-logs`, object store `events`, on the app's origin. Recordings survive ordinary reloads. The current-page download uses the current `sid`; **Download all sessions** includes retained older page loads. Clearing site data deletes those browser copies. Private browsing, eviction, storage restrictions, or quota exhaustion can prevent persistence.

**On the PC:** the Node server writes append-only files:

```text
spatial_mapping/
  logs/
    session-<page-session-id>.ndjson
```

`logs/` is Git-ignored. No rotation or automatic deletion silently discards older events. Monitor available disk space for long sessions. Server terminal output shows interaction/error summaries; pose samples and periodic heartbeats are kept in the files without flooding the terminal.

To choose another log directory for a run:

```powershell
$env:LOG_DIR = 'C:\Users\b.recoules\Downloads\quest-debug-logs'
node serve.mjs
```

Set this before starting the server. To stop using that override in the terminal:

```powershell
Remove-Item Env:LOG_DIR
```

**Live on the PC:** open `/logs.html`. Select a session, type a text filter, or show only warnings/errors. It refreshes every two seconds and displays up to the latest 300 events from a bounded file tail. Use **Download full session** for everything.

### Delivery, recovery, and limits

The browser first saves events in IndexedDB, sends bounded batches about once a second, and marks them delivered only after the server acknowledges a disk write. A reconnect or subsequent page load retries unsent events, including retained events from earlier pages. The server deduplicates retries, including after a restart. A storage/transport failure is visible in `SpatialLog.status` and in the Recording panel.

There is no absolute guarantee of the last events surviving a browser/OS crash or power loss. Logging is asynchronous: events not yet committed to browser storage can be lost. `pagehide`/visibility events request a best-effort flush; they cannot force a suspended or killed browser to finish. For a deliberate shutdown, exit AR, request synchronization, wait for acknowledgement, then close the tab.

The in-memory viewer tail is capped at 300 events; this does not trim IndexedDB or server files. If IndexedDB fails, unsaved events fall back to memory, capped at 10,000 events. Any overflow increments the visible `dropped` counter. That fallback disappears on reload. Large/circular console objects are normalized, deeply nested values and oversized payloads are explicitly marked as truncated, and typed arrays retain their type/length plus a small preview. This protects the frame loop from accidentally serializing entire room meshes. Ordinary event fields and error stacks fit within these limits.

Code that never loads, browser-native crashes, WebXR runtime internals, swallowed third-party exceptions, and network requests outside the page's observable error events require DevTools or device tools. Use DevTools **Network** for detailed request timing and response bodies. The app logger is not a full network capture.

## 5. GitHub Pages and other static hosts

Pages has no writable log endpoint. The app still records to IndexedDB and offers both download buttons after exiting AR. It does not repeatedly try to POST logs to Pages.

On loopback origins, server logging is discovered automatically. For another origin hosting this Node server, append `?logging=server` to enable discovery on that **same origin**. Use `?logging=browser` to deliberately test browser-only recording, even on localhost.

The URL chooses a mode, not a remote upload address. No third-party logging service is involved. Browser storage is per origin: logs on GitHub Pages are separate from logs on `localhost`, and changing ports also changes the origin.

## 6. Untethered local testing over LAN

The USB method is the easiest starting point because it supplies a secure loopback origin. Simply opening `http://YOUR_PC_IP:8450` on Quest is not enough for WebXR.

For LAN access you need a hostname/IP reachable from the Quest and an HTTPS certificate that the headset trusts. If you already have such a certificate/key, the included server can use them:

```powershell
$env:HOST = '0.0.0.0'
$env:PORT = '8450'
$env:HTTPS_KEY = 'C:\path\to\trusted-key.pem'
$env:HTTPS_CERT = 'C:\path\to\trusted-cert.pem'
node serve.mjs
```

Open `https://YOUR_CERTIFICATE_HOSTNAME:8450/?logging=server` in Quest Browser. The hostname must match the certificate. Allow the chosen port through the PC firewall for your development network if necessary. An untrusted self-signed certificate warning bypass is not a dependable WebXR setup. If you do not already have trusted local HTTPS, use USB forwarding or GitHub Pages.

The server binds to `127.0.0.1` by default. Setting `HOST=0.0.0.0` deliberately exposes the app and log viewer to devices that can reach that port; it has no login system. Do not publish this development logging server as a public service. Keep private keys outside the served project; `certs/` is also blocked by static serving and Git-ignored.

Remove the overrides in that terminal before returning to the standard USB workflow:

```powershell
Remove-Item Env:HOST, Env:PORT, Env:HTTPS_KEY, Env:HTTPS_CERT -ErrorAction SilentlyContinue
```

## 7. Troubleshooting

| Symptom | Check |
| --- | --- |
| `node` / `adb` not recognized | Confirm installation and PATH, or use the executable's full path |
| Address already in use | Stop the previous server or set another `PORT`; match the ADB mapping |
| Quest cannot open localhost | PC server running, ADB `device` state, reverse mapping present, exact same port |
| Desktop preview works but Enter AR is unavailable | Standalone Quest Browser, secure context, site permissions; the PC preview normally has no immersive AR |
| No meshes or planes | Run Space Setup, allow spatial data, inspect enabled features and detected/localized counts |
| Surfaces detected but invisible | Check `xr.tracking`, `surface.tracking`, visibility, and the chosen view; Reality endpoint is intentionally transparent |
| Tear gesture does nothing | Start hands close together; verify `hand.pinch`, `input.selectstart`, `tear.started`; menu clicks consume input |
| Tear closes instead of switching | Look at `tear.released.data.progress`; complete threshold is 0.5 |
| Startup stays on Loading | DevTools Network for CDN failures; Recording panel/console for `resource.error`, `console.error`, `promise.unhandled` |
| No PC recording | Confirm same-origin Node server, `/__logs/config.json` returns `spatial-log-v1`, and `SpatialLog.status.transport` is connected |
| Logs stop after USB disconnect | Browser copy remains in IndexedDB; reconnect, restore `adb reverse`, resume tab, and Sync |
| Viewer shows desktop activity instead of Quest | Select the Quest page session ID; inspect `page.start.data.userAgent` |
| Old code after editing | Disable cache while DevTools is open, reload, and confirm the URL points to this server |
| Storage error / memory-only mode | Export before reloading; check storage permissions/quota; inspect `dropped` and `lastError` |

To watch a particular full log directly in PowerShell:

```powershell
Get-Content -LiteralPath '.\logs\session-YOUR_SESSION_ID.ndjson' -Wait
```

To extract errors from a saved file:

```powershell
Get-Content -LiteralPath '.\logs\session-YOUR_SESSION_ID.ndjson' |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.level -eq 'error' } |
  Select-Object time, seq, event, data
```

## 8. Run the regression checks

From `spatial_mapping`:

```powershell
node tests/smoke.mjs
```

The harness starts its own ephemeral server and hidden headless Chrome, uses actual CDN modules, checks rendering/geometry/physics/gestures, and verifies the recorder. Logging checks cover server writes, acknowledgements, duplicate retries, restart recovery, invalid requests, disk failure, browser errors, bootstrap capture, markers, IndexedDB reload persistence, browser-only mode, and later delivery of unsent pages. Tests keep log files in temporary test directories rather than mixing them with normal `logs/` recordings.

Chrome defaults to `C:\Program Files\Google\Chrome\Application\chrome.exe`. Override if needed:

```powershell
$env:CHROME_PATH = 'C:\path\to\chrome.exe'
node tests/smoke.mjs
```

The test injects errors labeled `SPATIAL_LOG_TEST_*` to verify error recording. Those expected fixtures are distinguished from unexpected browser errors. Screenshot artifacts are in `.test-output/`. The tests cannot validate real Quest permissions, USB setup, stereo alignment, or actual hand-tracking reliability.

## Critic review corrections

Individual events are now capped at **20,000 serialized UTF-8 bytes**, with explicit truncation metadata. Older oversized outbox rows are bounded during upload while their original local data remains available. Typed-array previews copy only their first 32 elements; DataView previews use up to 32 bytes. This fixes a Unicode payload that previously blocked all later uploads. The server also supports streamed byte-range responses and rejects private key/certificate file extensions. See [REVIEW.md](REVIEW.md).
