# Preparing splats for Quest 3

Captures straight out of a scanner app are usually far too heavy for the Quest browser. This page explains what "Quest-ready" means for this app and how to get there with free tools. You can do it all in the browser with no install and no account, or from the command line. Tool details were checked in October 2026.

## Targets

| What | Target | Why |
| --- | --- | --- |
| Splats per object | **100K–300K** when you place several objects; up to **500K** for a single hero object | Spark renders at most **500K splats** in total on Quest, shared by every placed object. Anything above that still has to download and decode, and its LOD tree is built in the headset. For comparison, Meta's native Spatial SDK recommends **≤150K** per splat. |
| Spherical harmonics (SH) | **degree 1** (or 0) | The app renders SH degree 1 at most, so bands 2–3 are pure download and memory weight. |
| Extent | Crop to the object | Background, sky and floor are splats you pay for but don't want. |
| Floaters | Remove them | They cost frame time and fill a large share of the screen. The app's auto-fit ignores the outer 1% on each side, but floaters still render. |
| Format | **`.sog`** (smallest), or **`.spz` version 3** | Spark 2.3.1 loads `.sog`, `.spz` v1–3, `.ply`, `.compressed.ply`, `.splat`, `.ksplat` and `.rad`. |

For scale, the bundled samples are: `splat.sog`, 462K splats in 5.5 MB; `splat_heron.sog`, 18 MB; and `splatcaptspirulae.sog`, **2.9M splats in 36 MB, about six times the whole Quest budget**.

### Format traps

- **SPZ version 4 does not load in Spark 2.3.1.** It fails with "Unsupported SPZ version: 4". Niantic's converter, gsbox, `splat-transform` and the SuperSplat Editor all write v4 by default. Always choose **version 3**. ([Spark PR #332](https://github.com/sparkjsdev/spark/pull/332) adding v4 is still open.)
- **PlayCanvas "Streamed SOG" (`lod-meta.json`) is not a Spark format.** Use plain `.sog` instead. If you need streaming LOD, see the `.rad` section below.

## Route A: in the browser, no install, no login

Both tools are open source (MIT, by PlayCanvas). They process files locally in your browser; only publishing to their site needs an account.

1. **Clean up in the [SuperSplat Editor](https://superspl.at/editor).** Drag in your `.ply`, `.sog` or `.spz`.
   - **Crop:** use Box or Sphere selection around the object, then Select › Invert, then Delete.
   - **Floaters:** select them with the Sphere brush or Flood selection, with Selection Depth on (`N`), then Delete.
   - **Faint or huge splats:** in the Splat Data panel, drag-select the low end of the *Opacity* histogram or the high end of *Volume*, then Delete.
   - The splat count is shown in the editor. If it is already on target, export **SOG** (or **SPZ, version 3**) with **SH Bands = 1** and you are done.
   - Otherwise export **PLY**.
2. **Reduce the count in [SuperSplat Convert](https://superspl.at/convert).** Drop the PLY in.
   - Turn on **Decimate**. It takes a *percentage*, so compute target ÷ current count. For example, 250K from 1.2M is 21%. The page previews the resulting count.
   - Set **SH Bands** to **1**.
   - Output **`.sog`**. Convert can't write `.spz`; if you need SPZ, re-open the `.sog` in the Editor and export SPZ version 3.
3. Put the file next to `index.html` (or on any CORS-enabled host) and add it to the app's library.

## Route B: command line (repeatable, scriptable)

[`splat-transform`](https://github.com/playcanvas/splat-transform) (MIT) is the engine behind SuperSplat Convert. It needs Node.js 22+.

```bash
npm i -g @playcanvas/splat-transform

# 0) Inspect: splat count, value ranges, bounds
splat-transform capture.ply --stats null

# 1) Clean up, crop and drop SH bands above 1 (actions run left to right).
#    -B box is minX,minY,minZ,maxX,maxY,maxZ in the capture's own coordinates (read them from --stats).
#    -V opacity uses linear 0-1; scale_* uses metres. -F (GPU) removes floaters.
splat-transform -w capture.ply -N -B -1,-2,-1,1,0,1 \
  -V opacity,gt,0.05 -V scale_0,lt,0.5 -V scale_1,lt,0.5 -V scale_2,lt,0.5 \
  -F -H 1 clean.ply

# 2) Decimate to an exact count. It must be the last action and must write .ply.
#    -d removes evenly; --decimate-adaptive spends the budget where detail is.
splat-transform -w clean.ply --decimate-adaptive 250000 small.ply

# 3) Deliver
splat-transform -w small.ply object.sog                      # recommended
splat-transform -w --spz-version 3 small.ply object.spz      # if you need SPZ: force v3
```

## Optional: precomputed LOD (`.rad`)

The app builds an LOD tree for every non-`.rad` asset at load time. That takes seconds on a PC for a 300K-splat object, but can take minutes in the headset for millions of splats. A `.rad` file contains a precomputed LOD tree and streams in pages, so only what is visible is downloaded. It is worth making when an object must stay large, or when you place many objects. The only tool that writes `.rad` is Spark's own `build-lod`, which needs [Rust](https://rustup.rs). No online version exists.

```bash
git clone https://github.com/sparkjsdev/spark && cd spark
npm run build-lod -- /abs/path/small.ply --quality --max-sh=1 --rad-chunked
# -> small-lod.rad + small-lod-*.radc chunks; serve them together
```

The app loads every `.rad` URL with Spark's paged streaming, so always use `--rad-chunked`. The host must support HTTP range requests and CORS; `serve.mjs` does.

## Checking the result on the headset

- Watch the `hb` heartbeat (fps every 5 s) in the Logs panel or `logs.html`. Quest WebXR sessions run at 72 fps.
- Tune without editing code, using URL parameters:
  - `?budget=300000` lowers Spark's splat budget.
  - `?xrscale=0.6` lowers the render resolution (default 0.75).
  - Combine them: `?budget=300000&xrscale=0.6`.
- A slow frame rate when an object fills your view is overdraw (too many large, overlapping splats), not total count. Crop or remove big transparent splats, or lower `xrscale`.

## Why there's no custom tool

The two routes above already cover cropping, floater removal, SH reduction, decimation and Spark-compatible output without an account. The remaining gaps are small:

- Online decimation takes a percentage, not a count.
- Automatic floater and opacity filters (`-F`, `-V`) exist only in the CLI; online you select them by hand.
- No browser tool writes `.rad`.

If these become a pain, a small page in this repo could load a capture with Spark and write a cleaned SPZ v3 locally: Spark 2.3.1 exports `transcodeSpz` with crop box, opacity threshold and SH cap. Build that only if the routes above prove too slow in practice.

Other tools checked and not recommended here:

- **Niantic `spz`** writes v4 only.
- **gsbox** is GPL-3.0, ships no binaries, and writes v4 by default.
- **NanoGS** is non-commercial (CC BY-NC) and outputs PLY only.
- **Polycam, Luma and KIRI** need accounts. Use them only to get the source PLY.
