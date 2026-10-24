# neomosh

neomosh is a video recorder in one standalone HTML file. It makes a **true datamosh**: it has its own H.264 encoder and decoder. When you pause and resume, the new clip has no keyframe. The P-frames of the new clip move the pixels of the last picture of the previous clip.

The exported file is a valid H.264 (Constrained Baseline) stream. Each conforming player shows the same moshed pictures.

> Status: development. Phase 1 (codec core) is done. The recorder UI comes in Phase 3. See `neomosh-plan-v0.1.0.md`.

## Development

Requirements: Node.js 20 or later. FFmpeg and ffprobe for the tests.

| Command | Result |
|---|---|
| `node tools/build.mjs` | Makes `dist/neomosh-v0.1.0.html` and `dist/neomosh-bench-v0.1.0.html` |
| `node tests/run.mjs [filter]` | Runs the tests. Output files go to `tests/out/` |
| `node tools/bench.mjs [frames]` | Runs the encoder benchmark in Node |

### Benchmark on a phone

1. Run `node tools/build.mjs`.
2. Copy `dist/neomosh-bench-v0.1.0.html` to the phone (for example with AirDrop or Files), or serve it from a local web server.
3. Open it, tap **Run**, and wait until it shows "Done".
4. Tap **Copy results** and send the text.

The page makes no network requests. The encoder p95 time must be below the frame budget: 33.3 ms at 30 fps, 41.7 ms at 24 fps, 66.7 ms at 15 fps.

### Tests

The tests encode synthetic video, write an Annex B `.264` file, and decode it with FFmpeg. The FFmpeg output must be byte-identical to the output of our decoder (plan §13.1). The mosh test (plan §13.2) makes sure that, after a cut, only the area along the motion path changes.

### Layout

| Path | Contents |
|---|---|
| `src/codec/` | H.264 subset: bit I/O, tables, transform, interpolation, motion vector prediction, CAVLC, headers, colour, encoder, decoder |
| `src/bench/` | Benchmark page and core |
| `src/app/` | App (stub until Phase 3) |
| `src/mux/` | MP4 muxer (Phase 2) |
| `tools/build.mjs` | Inlines all sources into one HTML file for each page |
| `tests/` | Node tests |
| `dist/` | Built files |

## Known limits

- The mosh needs movement. If nothing moves after a resume, the old picture stays frozen.
- The export has only one sync frame (frame 0), unless a cut is set to Clean. Players seek slowly in long files.
- I-frames use I_PCM (no compression). Their bitrate can be above the level limit. The level is selected only from the frame size and the macroblock rate.
