# neomosh

neomosh is a video recorder in one standalone HTML file. It makes a **true datamosh**: it has its own H.264 encoder and decoder. When you pause and resume, the new clip has no keyframe. The P-frames of the new clip move the pixels of the last picture of the previous clip.

The exported file is a valid H.264 (Constrained Baseline) stream. Each conforming player shows the same moshed pictures.

> Status: development. Phases 1 to 3 are done: codec, MP4 export, and the recorder. History and undo, the file source, audio, and the full settings panel come in Phases 4 to 7.

## How to use

1. Put `dist/neomosh-v0.1.0.html` on a web server with HTTPS (for example GitHub Pages), or open it on `localhost`. Browsers refuse camera access on plain HTTP. Safari also refuses it on a local `file://` page.
2. Touch **Start** and give permission to the camera.
3. Touch the red button to record. The view shows the decoded output of the encoder.
4. Touch the button again to pause. The last picture shows above the live camera. Move the **Guide** slider to change its opacity, and align the next shot.
5. Touch the red button to resume. The new clip has no keyframe, so its motion moves the old picture. This is the datamosh. The mosh needs movement: if nothing moves, the old picture stays frozen.
6. Repeat steps 4 and 5 as many times as necessary.
7. Touch **Export** (top right). For each cut, select **Mosh** or **Clean**. Touch **Export**, then **Save Video** (iOS) or **Download**.

The gear (top left) sets the size and the frame rate before the first recording, and turns the mosh preview and the front-camera mirror on or off. An amber badge shows the count of frames that the encoder dropped. Touch it for help.

The app keeps the video in the browser storage (IndexedDB) until you start a new video. See `neomosh-plan-v0.1.0.md`.

## Development

Requirements: Node.js 20 or later. FFmpeg and ffprobe for the tests.

| Command | Result |
|---|---|
| `node tools/build.mjs` | Makes `dist/neomosh-v0.1.0.html` and `dist/neomosh-bench-v0.1.0.html` |
| `node tests/run.mjs [filter]` | Runs the tests. Output files go to `tests/out/` |
| `node tools/bench.mjs [frames]` | Runs the encoder benchmark in Node |
| `node tools/sample.mjs` | Makes sample MP4 files in `samples/` for device tests |

### Benchmark on a phone

1. Run `node tools/build.mjs`.
2. Copy `dist/neomosh-bench-v0.1.0.html` to the phone (for example with AirDrop or Files), or serve it from a local web server.
3. Open it, tap **Run**, and wait until it shows "Done".
4. Tap **Copy results** and send the text.

The page makes no network requests. The encoder p95 time must be below the frame budget: 33.3 ms at 30 fps, 41.7 ms at 24 fps, 66.7 ms at 15 fps.

### Tests

The tests encode synthetic video, write an Annex B `.264` file and an `.mp4` file, and decode them with FFmpeg. The FFmpeg output must be byte-identical to the output of our decoder (plan §13.1). The MP4 packets must have the correct times, durations, and sync flags. When Playwright is installed, a test also decodes the MP4 samples with the Chromium WebCodecs decoder and plays the files in a `<video>` element, and a test operates the built app with a fake camera: record, pause, resume, export. The mosh test (plan §13.2) makes sure that, after a cut, only the area along the motion path changes.

### Layout

| Path | Contents |
|---|---|
| `src/codec/` | H.264 subset: bit I/O, tables, transform, interpolation, motion vector prediction, CAVLC, headers, colour, encoder, decoder |
| `src/bench/` | Benchmark page and core |
| `src/app/` | App: user interface (based on neocamera v1.5.0), recorder, workers, storage |
| `src/mux/` | MP4 muxer and lossless export (remux) |
| `tools/build.mjs` | Inlines all sources into one HTML file for each page |
| `tests/` | Node tests |
| `dist/` | Built files |

## Known limits

- The mosh needs movement. If nothing moves after a resume, the old picture stays frozen.
- The export has only one sync frame (frame 0), unless a cut is set to Clean. Players seek slowly in long files. Playback is normal.
- At a Mosh cut, the hidden I-frame is not in the file. The frame before the cut stays on screen for that time, so the timeline has no gap.
- I-frames use I_PCM (no compression). Their bitrate can be above the level limit. The level is selected only from the frame size and the macroblock rate.
