# neomosh

neomosh is a video recorder in one standalone HTML file. It makes a **true datamosh**: it has its own H.264 encoder and decoder. When you pause and resume, the new clip has no keyframe. The P-frames of the new clip move the pixels of the last picture of the previous clip.

The exported file is a valid H.264 (Constrained Baseline) stream. Each conforming player shows the same moshed pictures.

> Status: v0.1.0. All phases are done: codec, MP4 export, recorder, history, file source, settings, and Upscale export. neomosh records video only (no audio). See `neomosh-plan-v0.1.0.md`.

## How to use

1. Put `dist/neomosh-v0.1.0.html` on a web server with HTTPS (for example GitHub Pages), or open it on `localhost`. Browsers refuse camera access on plain HTTP. Safari also refuses it on a local `file://` page.
2. Touch **Start** and give permission to the camera.
3. Touch the red button to record. The view shows the decoded output of the encoder.
4. Touch the button again to pause. The last picture shows above the live camera. Move the **Guide** slider to change its opacity, and align the next shot.
5. Touch the red button to resume. The new clip has no keyframe, so its motion moves the old picture. This is the datamosh. The mosh needs movement: if nothing moves, the old picture stays frozen.
6. Repeat steps 4 and 5 as many times as necessary.

   **Bloom**: while paused, hold the **BLOOM** button (next to the red button, or the B key). The motion at the end of the last clip repeats, so the picture keeps flowing and smearing in that direction. Release it to end the bloom: it is a clip of its own, with a pause point. The bloomed picture stays, and the next clip moshes on from it.

   To use a video file as the source (at the start or at any pause point), touch **FILE** and select a file. The **File** slider below the view sets the start point. The file plays at normal speed while you record, and pauses with the recording. At the end of the file, the recording pauses. Touch **FILE** again to select a different file, or **CAMERA** to go back to the camera. A file is never mirrored. The sound of the file is not recorded. If the camera is not available, the start screen offers **Use a video file**.
7. To go back, touch the thumbnail (bottom left) while paused. The **History** sheet plays the video and shows one card for each pause point. Touch a card, then **Revert**, to delete all clips after that point and continue from it. **Start** deletes all clips. **New video** deletes the video.
8. Touch **Export** (top right). For each cut, select **Mosh** or **Clean**. Touch **Export**, then **Save Video** (iOS) or **Download**.

   **Original** mode (the default) copies the recorded frames into the file. It is fast and lossless. **Upscale** mode scales the video to 1080 on the short side (**Sharp** keeps the blocks, **Smooth** blurs them) and encodes it again with the H.264 encoder of the browser. Upscale shows only when the browser has an H.264 encoder.

An amber badge shows the count of frames that the encoder dropped. Touch it for help.

## Settings

Touch the gear (top left).

| Setting | Values | Default | When it can change |
|---|---|---|---|
| Size (short side) | 360, 480, 720, 1080 | 480 | Before the first recorded frame. 720 and 1080 need a fast device |
| Frame rate | 15, 24, 30 | 30 | Before the first recorded frame. A hint shows when the device is too slow for the rate |
| Shape | 1:1, 4:3, 3:2, 16:9; vertical or horizontal | 4:3, from the screen | Before the first recorded frame (bar above the view) |
| Quality (QP) | 16–44 | 28 | While paused. High = coarse blocks; low = clean detail, larger file |
| Search range | ±8, ±16, ±32, ±64 | ±32 | While paused. Larger = longer smears with fast motion, more CPU |
| Motion | Full, Half, Quarter | Half | While paused. Full = blocky steps; Quarter = smooth flowing smear |
| Skip bias | 0–100 | 50 | While paused. High = more old pixels stay |
| Heal | Off, Low, High | Off | While paused. Low and High repair bad areas (partial mosh) |
| Mosh preview | On, Off | On | At any time. Off shows the raw source while recording |
| Mirror front camera | On, Off | On | At any time. Applies to the next clip |

The encoder settings apply to the next clip. Each clip keeps its own look. A revert also restores the settings of that pause point. **Default look** sets the encoder settings to their defaults. The info section shows the encoder time for each frame, the dropped frames, and the storage used and free.

## Browser support

| Browser | Status |
|---|---|
| Chrome (Android, desktop) | Tested. Upscale export is available |
| Edge | Same engine as Chrome. Not tested |
| Safari (iOS 16.4 or later, macOS) | Must work. Not tested yet (plan §13.4). Upscale export when Safari has an H.264 `VideoEncoder` |
| Firefox 132 or later | Must work. Not tested |

The browser must have WebAssembly SIMD for full speed. Without it, the codec uses JavaScript, which is approximately 10 times slower. The page makes no network requests.

For a check of a device, open the page with `#debug` at the end of the address. The settings sheet then shows **Run the self-test**. It exports the video, decodes it with the decoder of the browser, and compares each frame with the neomosh decoder. The result must be "PASS. Identical".

The app keeps the video in the browser storage (IndexedDB). When you open the app again, touch **Continue last video** to continue from the last pause point, or **Start new**. If the app closed during a recording, it keeps the frames that were stored (all but about the last second) and makes a new pause point.

## Development

Requirements: Node.js 20 or later. FFmpeg and ffprobe for the tests.

| Command | Result |
|---|---|
| `node tools/build.mjs` | Makes `dist/neomosh-v0.1.0.html` and `dist/neomosh-bench-v0.1.0.html`, and copies the app to `index.html` (the page for GitHub Pages) |
| `node tools/build-wasm.mjs` | Compiles `src/codec/wasm/kernels.c` to WebAssembly (needs clang with the wasm32 target). Only after a change to the C code: the compiled module is in the repository |
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

The tests encode synthetic video, write an Annex B `.264` file and an `.mp4` file, and decode them with FFmpeg. The FFmpeg output must be byte-identical to the output of our decoder (plan §13.1). The MP4 packets must have the correct times, durations, and sync flags. When Playwright is installed, a test also decodes the MP4 samples with the Chromium WebCodecs decoder and plays the files in a `<video>` element, and tests operate the built app with a fake camera: record, pause, resume, history, settings, storage full, Original and Upscale export, and the self-test. The mosh test (plan §13.2) makes sure that, after a cut, only the area along the motion path changes.

### Layout

| Path | Contents |
|---|---|
| `src/codec/` | H.264 subset: bit I/O, tables, transform, interpolation, motion vector prediction, CAVLC, headers, colour, encoder, decoder |
| `src/codec/wasm/` | The computation-intensive parts of the codec in C, compiled to WebAssembly with SIMD. The JavaScript functions are the fallback and the reference; the tests prove that both give the same bits |
| `src/bench/` | Benchmark page and core |
| `src/app/` | App: user interface (based on neocamera v1.5.0), recorder, workers (capture, encoder, decoder), storage, Upscale export, self-test |
| `src/mux/` | MP4 muxer and lossless export (remux) |
| `tools/build.mjs` | Inlines all sources into one HTML file for each page |
| `tests/` | Node tests |
| `dist/` | Built files |

## Known limits

- The mosh needs movement. If nothing moves after a resume, the old picture stays frozen.
- The export has only one sync frame (frame 0), unless a cut is set to Clean. Players seek slowly in long files. Playback is normal.
- At a Mosh cut, the hidden I-frame and its time slot are not in the file: each Mosh cut makes the video one frame shorter, and there is no hold of the last picture before the cut.
- The live view can skip pictures when the decoder is late. This is by design: the recording has priority, and the file keeps all frames. The info section shows the count ("view skipped").
- I-frames use I_PCM (no compression). Their bitrate can be above the level limit. The level is selected only from the frame size and the macroblock rate.
- A slow device drops frames. Touch the amber badge: it shows the cause. "Encoder busy": use a smaller size, a lower frame rate, or a smaller search range. "Page late": the page did not get all camera frames; close other apps. In Chrome, the camera frames go to a capture worker, so the page is not in the frame path. In other browsers, and for a file source, the page captures the frames.
- No audio. The browser has no AAC encoder on all platforms, and audio made the frame drops worse (plan D20).
- When the storage is full, the recording pauses and the last clip is not kept. Export the video, or free some space.
