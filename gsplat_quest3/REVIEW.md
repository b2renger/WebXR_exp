# Independent critic review — 2026-09-10

Status: critic approved after four review rounds. No remaining actionable findings were identified within the documented prototype scope. The critic independently reran both final suites: spatial mapping 66 checks and splat placer 54 checks, both exit 0 without unexpected browser errors. Reviewed files were applied to the requested project folders and verified by SHA-256; existing splat assets and the previous recording were preserved.

The user requested an independent critic, review against the intended goals, and a fix/review loop until satisfied. The critic performed read-only reviews while the primary agent implemented corrections and ran regressions. Browser tests are not a substitute for a Quest session.

## Review rounds

1. The critic rejected the baseline: expired XR frames during splat anchoring, stale asynchronous anchor results, unsaved two-grip edits, destructive invalid imports, private HTTPS-key exposure, missing input cancellation, lossy splat logging, and an independently reproduced Unicode outbox stall.
2. After those fixes, the critic rejected the first revision: unconditional edited flags blocked auto-fit; gamepads could still move items after tracking loss; replacement placement retained an obsolete persistent UUID; failed assets and invalid stored JSON could erase a saved layout.
3. Those findings were corrected. The critic then identified a cross-session hit-test race and reversed/incorrectly rotated thumbstick movement.
4. Hit-test acquisition now assigns only a current session's result. Movement uses head direction and the inverse room orientation. Four orientation cases and a delayed old-session result pass targeted regressions; the critic approved the corrections after independent test reruns.

## Cross-project corrections

- Both directories remain standalone static apps, with no build system. Each has its own optional Node server, recorder, viewer, documentation and tests.
- The recorder saves events in IndexedDB, retries unsent events, exports NDJSON and only treats PC batches as delivered after durable server acknowledgement. Unicode data is byte-bounded and legacy oversized entries cannot block the queue.
- The server defaults to loopback, blocks private files and paths outside its resolved root, rejects cross-origin log injection, and handles HTTP byte ranges without buffering entire assets.
- Errors, interactions and sampled poses are diagnostic records, with explicit limits. They are not a lossless sensor recording, video capture or deterministic replay.

## Remaining headset validation

Actual Quest permission prompts, room scan quality/alignment, persistent-anchor relocalization, controller/hand tracking, stereo depth occlusion, and memory/frame rate require manual hardware testing. No Quest was connected for this review. The original X demo's reconstruction pipeline remains unknown; no claim is made that these apps reproduce its dense capture quality.

## Splat placer: goal and result

The original gsplat brief is not available in the review conversation. Its existing source/UI establishes a multi-splat Quest AR placement experiment with runtime LOD, paged RAD support, depth occlusion, controller manipulation and saved room layouts. That inferred scope is preserved; it is distinct from reconstructing the physical room.

The revision extracts the inline module into app.js, queues anchor placement into active XR frames, uses session/generation ownership for async results, saves pinch release, cancels stale input, validates imports before replacement, exports current state and preserves layouts across asset outages or corrupt stored JSON. Persistence-off skips restore; explicit re-anchor detaches obsolete UUIDs. New auto-fit respects actual edits. Failed items remain available for explicit deletion or reload retry.

The old lossy recorder/server is replaced with the durable static-compatible recorder, and the previous log file is preserved untouched. Use node serve.mjs on port 8443 and [LOCAL_DEBUGGING.md](LOCAL_DEBUGGING.md). The former /log, /logs, destructive GET clear route and automatic 8444 HTTPS listener are retired.

Validation: **54 checks passed**, including real bundled SOG loading with Spark, delayed fitting, invalid-import preservation, active-frame anchoring, stale restore rejection, pinch persistence, input cancellation, missing-asset preservation, invalid-storage preservation, range requests, durable logging and blocked-CDN startup. Paged RAD asset loading and actual GPU depth occlusion need manual validation; the included captures are SOG files. Run node tests/smoke.mjs.


