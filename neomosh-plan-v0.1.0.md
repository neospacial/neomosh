# neomosh — Implementation Plan (for app version 0.1.0)

Writing style: ASD-STE100 Simplified Technical English. Keep this style in the README and in code comments.

---

## 0. How to use this file

1. Do the phases in §14 in sequence. Do not start a phase before the acceptance tests of the previous phase pass.
2. Requirement IDs (`R-xx`) are used in commits, tests, and code comments.
3. If code and this file disagree, stop and ask Ryan. Do not change a decision in §2 without approval.
4. Ryan's file rule: each delivered file has the version in its name, for example `neomosh-v0.1.0.html`.

---

## 1. Summary

neomosh is a video recorder in one standalone HTML file. It has no network calls and no runtime libraries. Its UI is based on neocamera v1.5.0 (an iPhone-camera-style app by Ryan).

neomosh makes a **true datamosh**. It does not use pixel effects. The app has its own H.264 encoder and its own H.264 decoder. When you pause and then resume, the app does not write a keyframe for the new clip. The P-frames of the new clip then move the pixels of the last picture of the previous clip.

Main flow:

1. The app opens. The viewfinder shows the **decoded output** of the encoder (live mosh view).
2. Tap record. The encoder records clip 1 (one IDR frame, then P-frames).
3. Tap again to pause. The last decoded frame shows over the live source at 50% opacity. A slider changes the opacity. You align the shot.
4. Tap record to resume. The new clip has no visible keyframe. Its P-frames move the old picture. This is the datamosh.
5. Repeat pause and resume as many times as necessary. Each pause point is kept in a history. You can go back to any pause point and try again.
6. At any pause point (or at the start), you can select a video file as the source. The encoder handles it the same as the camera.
7. Tap **Export** (top right). The app writes a correct MP4 file. The default export is a lossless remux of our own H.264 stream (no re-encode, no real-time playback).

---

## 2. Decisions log (from the planning chat)

| # | Decision |
|---|---|
| D1 | App name: **neomosh**. File: `neomosh-v0.1.0.html`. |
| D2 | Terms: an **I-frame** is a full picture. A **P-frame** is motion vectors plus a residual. The mosh comes from a P-frame chain with no I-frame at a cut. |
| D3 | We write our own encoder and our own decoder. Browser encoders are not used for the mosh stream. |
| D4 | The overlay shows the **decoded** last frame (moshed), not the camera frame. |
| D5 | The overlay is visible **only while paused**. While recording, the viewfinder shows the live decoded output. |
| D6 | Viewfinder default: decoded output ("Mosh preview" On). A setting can change it to the raw source. |
| D7 | Heal default: **Off**. A setting can turn it on. |
| D8 | Front camera: mirrored by default, as displayed. A setting can change this. |
| D9 | Settings panel with all encoder settings. Each setting has only values that still make a datamosh. |
| D10 | Frame-drop warning: a small, non-obtrusive badge. |
| D11 | (Replaced by D20: no audio.) Audio: at startup, check for an AAC `AudioEncoder`. If it is available, record audio for each clip (option B). If not, there is no audio, and a small badge tells the user. |
| D12 | Export: use the most efficient bake method that does not change the look and does not make a corrupt file. Selected method: **lossless remux** (see §9). It must be verified by tests (§13). |
| D13 | Export button: **top right**. Camera switch: **bottom right**. |
| D14 | Undo with full history. The user can go back to **any** pause point, not only one step. |
| D15 | Video file source: at the start or at any pause point. The encoder does not know the source. |
| D16 | No reference clip for the look at this time. Default settings give a "classic" mosh. |
| D17 | 720 size: all frame rates stay available. When the selected rate is more than the device can hold, the settings panel shows a hint (§7.1). The app does not change the rate (R-20). |
| D18 | No `navigator.storage.persist()` request: some browsers show a permission prompt for it. The app uses best-effort storage, writes often, and warns when free storage is low (R-26). |
| D19 | Encoder queue: a maximum of 6 frames in flight (R-18), not 2. The buffer (about 200 ms at 30 fps) absorbs short CPU load peaks from other apps without drops. It does not change the look or the file. The live mosh view can be late by up to this time during a peak. |
| D20 | **No audio.** Audio is removed from the app (it replaces D11): no microphone, no file sound, no AAC, no audio badge, video-only MP4. §10, R-30, the audio rows of §4, §11.3, and §12, and Phase 6 do not apply. Reason: the app must use all of the device for the encoder. |

Change from the planning chat (needs Ryan's approval only if he disagrees): Ryan expected that settings can change only before a video starts. Analysis shows that **only the size, the aspect ratio, the orientation, and the frame rate** must be locked for the session. All other encoder settings are stored for each frame. Thus they can change **while paused** (each clip can have different settings). They cannot change while recording. See §7.

---

## 3. Why the method works (read this before you write codec code)

### 3.1 The classic datamosh

An encoder makes a P-frame as follows: it finds, for each block, the best matching block in the reference picture (motion vector). It then codes the difference (residual). A normal decoder uses the same reference picture, so the result is correct.

At a cut, a normal encoder writes an I-frame. If the I-frame is removed, the decoder applies the P-frames of the new scene to the **old** picture. Old pixels move with the motion of the new scene.

### 3.2 How neomosh does it

1. Clip 1 starts with an IDR frame. All other frames are P-frames.
2. At resume, the encoder codes the first new source frame as an I-frame. This frame is **hidden**. It is stored, but it is not put in the decoded/exported stream. The encoder uses it only as its own reference.
3. The encoder codes the next frames as P-frames against its own reference chain (the new scene). The motion vectors and the residuals are small and correct for the new scene.
4. The decoder does not have the hidden I-frame. It applies the P-frames to its last picture (the old, maybe moshed, picture). This is the datamosh.

Necessary rules:

- **R-01** No scene-cut detection. The encoder never adds an I-frame by itself.
- **R-02** No periodic keyframes. The only IDR is frame 0 of the session.
- **R-03** With Heal Off, no intra macroblocks in P-frames. With Heal On, intra macroblocks are permitted when inter prediction is bad (§6.6).
- **R-04** The encoder uses its own **reconstructed** frames as references, never the raw source frames.
- **R-05** The encoder reconstruction and the decoder output must be bit-exact (same integer math). They share one code module.

Behavior to explain in the README: the mosh needs movement. If nothing moves after a resume, the old picture stays frozen. This is correct.

### 3.3 Why the exported file is not corrupt

A typical datamosh deletes I-frames from an existing file. This breaks `frame_num` order and makes a broken stream. Many hardware decoders then freeze or show grey blocks.

neomosh does not delete anything from a finished stream. It writes every bit itself. At export, it writes slice headers with correct `frame_num` values for the frames it keeps. The result is a **valid H.264 Constrained Baseline stream**: one IDR, then P-frames. Each P-frame refers to the frame before it, and that frame exists.

The stream is valid, but its pictures are moshed. The reason: the P-frame data was made against a different reference picture (the hidden one). A decoder cannot see this. It only applies the data.

H.264 decoding is **bit-exact by the standard**. Each conforming decoder must give the same output pixels for a valid stream. Thus the exported file looks the same in each player as in our decoder. The tests in §13 prove this with FFmpeg and WebCodecs.

---

## 4. Platform requirements

Runtime (no libraries):

| Feature | Use | Required? |
|---|---|---|
| `getUserMedia` | Camera and microphone | Yes (or file source only) |
| Web Worker from a Blob URL | Encoder and decoder threads | Yes |
| `OffscreenCanvas` 2D in a worker | Source frame to pixels | Yes (Safari 16.4+) |
| `createImageBitmap` with crop and resize | Fast frame capture | Yes |
| IndexedDB | Session storage | Yes |
| `requestVideoFrameCallback` | Frame timing | Optional (fallback: rAF) |
| `AudioWorklet` (module from a Blob URL) | PCM capture | For audio |
| `AudioEncoder` with `mp4a.40.2` | AAC at export | For audio (D11) |
| `VideoEncoder` (H.264) | Only for the "Upscale" export | Optional |
| `VideoDecoder` | Only for the in-app self-test | Optional |
| `navigator.share({files})` | iOS "Save Video" to Photos | Optional (fallback: download link) |
| Wake Lock | Screen on while recording | Optional |

The default (lossless) export needs **no WebCodecs** for video. It works in all browsers that can run the recorder.

Development tools (not in the shipped file): Node.js 20+ and FFmpeg (for verification only).

---

## 5. Architecture

### 5.1 Threads

```
 Source (camera <video> or file <video>)
   │  rVFC / rAF, throttled to target fps
   ▼
 Main thread: createImageBitmap(crop + resize)  ──transfer──►  ENCODER WORKER
                                                                 RGB→YUV 4:2:0
                                                                 mode decision, ME, MC
                                                                 transform, quant, CAVLC
                                                                 reconstruction (own reference)
   ◄──────────── packet {meta, sliceBits} ─────────────────────┘
 Main thread: store packet (IndexedDB), forward to decoder
   │
   ▼
 DECODER WORKER: CAVLC parse, MC, dequant, inverse transform
   │  keeps the "display reference" (the moshed picture)
   ▼
 ImageBitmap ──► main thread viewfinder canvas, thumbnail, overlay
```

- **R-06** The encoder and the decoder run in separate workers. The main thread does UI, capture, storage, and export.
- **R-07** The encoder does not skip hidden frames. The decoder ignores hidden frames (it does not update its reference).
- **R-08** The decoder can be reset to a stored reference picture (for revert and session restore).

### 5.2 Repository layout (development)

The app ships as one HTML file. For development and for Node tests, keep the source as modules, and use a small build script.

```
/PLAN.md                      (this file)
/README.md                    (GitHub format, no license section)
/src/codec/bitio.js           bit writer, bit reader, Exp-Golomb, emulation prevention
/src/codec/tables.js          CAVLC tables, zigzag, CBP mapping, chroma QP table, LevelScale
/src/codec/transform.js       4x4 forward/inverse integer transform, quant, dequant, chroma DC
/src/codec/inter.js           luma 6-tap and chroma bilinear interpolation, edge clamp
/src/codec/mvpred.js          motion vector prediction, P_Skip vector
/src/codec/cavlc.js           residual_block write and read, nC rules
/src/codec/encoder.js         frame encoder (mode decision, ME, reconstruction)
/src/codec/decoder.js         frame decoder (subset of H.264 that the encoder makes)
/src/codec/headers.js         SPS, PPS, slice header writers, NAL wrapper
/src/codec/color.js           RGBA↔YUV 4:2:0 (BT.709 limited range)
/src/mux/mp4.js               MP4 muxer (video + optional AAC)
/src/app/*.js                 UI, capture, storage, audio, export, settings
/src/app/index.html, style.css
/tools/build.mjs              inlines all into dist/neomosh-v<version>.html
/tests/*.mjs                  Node tests (see §13)
/dist/neomosh-v0.1.0.html     shipped file
```

- **R-09** The codec modules are plain JavaScript with no dependencies. They run in Node, in a worker, and on the main thread.
- **R-10** The build inlines the worker code as text and makes the workers from Blob URLs. The shipped file makes no network requests.

---

## 6. Codec specification (H.264 Constrained Baseline subset)

References are to ITU-T Rec. H.264. The encoder writes only the features in this section. The decoder reads only these features.

### 6.1 Picture format

- YCbCr 4:2:0, 8 bit. Colour: BT.709, limited range (16–235 / 16–240). Signal it in the VUI (§6.2).
- Coded size: multiples of 16. Visible size: even numbers. Use SPS frame cropping for the difference. The encoder pads the input by edge copy.
- One slice for each picture. All pictures are reference pictures (`nal_ref_idc = 3`).
- Deblocking filter: **off** (`disable_deblocking_filter_idc = 1`). The decoder thus needs no deblocking filter.

### 6.2 SPS (nal_unit_type 7)

| Field | Value |
|---|---|
| profile_idc | 66 |
| constraint_set0_flag, constraint_set1_flag | 1, 1 (Constrained Baseline) |
| level_idc | Lowest level that holds MB/s and frame size (§6.9) |
| seq_parameter_set_id | 0 |
| log2_max_frame_num_minus4 | 12 (frame_num has 16 bits) |
| pic_order_cnt_type | 2 (output order = decode order) |
| max_num_ref_frames | 1 |
| gaps_in_frame_num_value_allowed_flag | 0 |
| pic_width_in_mbs_minus1, pic_height_in_map_units_minus1 | from coded size |
| frame_mbs_only_flag | 1 |
| direct_8x8_inference_flag | 1 |
| frame_cropping_flag + offsets | when visible size ≠ coded size (units of 2 px) |
| vui_parameters_present_flag | 1 |
| VUI: video_signal_type_present_flag | 1; video_format 5; video_full_range_flag 0; colour_description_present_flag 1; primaries 1, transfer 1, matrix 1 |
| VUI: timing_info_present_flag | 0 (the MP4 holds the time) |
| VUI: bitstream_restriction_flag | 1; motion_vectors_over_pic_boundaries_flag 1; max_bytes_per_pic_denom 0; max_bits_per_mb_denom 0; log2_max_mv_length_horizontal 16; log2_max_mv_length_vertical 16; max_num_reorder_frames 0; max_dec_frame_buffering 1 |

### 6.3 PPS (nal_unit_type 8)

pic_parameter_set_id 0; seq_parameter_set_id 0; entropy_coding_mode_flag 0 (CAVLC); bottom_field_pic_order_in_frame_present_flag 0; num_slice_groups_minus1 0; num_ref_idx_l0_default_active_minus1 0; num_ref_idx_l1_default_active_minus1 0; weighted_pred_flag 0; weighted_bipred_idc 0; pic_init_qp_minus26 0; pic_init_qs_minus26 0; chroma_qp_index_offset 0; deblocking_filter_control_present_flag 1; constrained_intra_pred_flag 0; redundant_pic_cnt_present_flag 0.

### 6.4 Slice header (written at export time, §9.2)

The encoder stores only `slice_data()` bits. The muxer writes the header. Reason: `frame_num` depends on which frames the export keeps (mosh or clean cuts).

Fields in sequence (7.3.3):

1. first_mb_in_slice ue = 0
2. slice_type ue = 7 (I) or 5 (P)
3. pic_parameter_set_id ue = 0
4. frame_num u(16): 0 for the IDR, then +1 (mod 65536) for each kept picture
5. IDR only: idr_pic_id ue = 0
6. P only: num_ref_idx_active_override_flag u(1) = 0; ref_pic_list_modification_flag_l0 u(1) = 0
7. dec_ref_pic_marking: IDR → no_output_of_prior_pics_flag 0, long_term_reference_flag 0; non-IDR → adaptive_ref_pic_marking_mode_flag 0
8. slice_qp_delta se = frameQP − 26
9. disable_deblocking_filter_idc ue = 1

Then append the stored `slice_data()` bits **bit by bit** (the header length is not byte aligned). Then `rbsp_slice_trailing_bits` (a 1 bit, then 0 bits to the byte boundary). Then apply emulation prevention (insert 0x03 after two 0x00 bytes when the next byte ≤ 0x03).

NAL types: frame 0 → type 5 (IDR). Others → type 1. A hidden I-frame that the user includes as a "clean" cut → type 1 with slice_type 7 (non-IDR I picture).

### 6.5 Macroblock types used

| Picture | mb_type value | Meaning |
|---|---|---|
| I | 25 | I_PCM |
| P | (skip run) | P_Skip, coded by `mb_skip_run` |
| P | 0 | P_L0_16x16 |
| P | 30 | I_PCM (intra in P; only with Heal On) |

Version 1 uses only 16×16 partitions. I-pictures use only I_PCM. I_PCM is lossless, so the hidden I-frame reconstruction equals the source frame exactly.

I_PCM syntax: `pcm_alignment_zero_bit` to the byte boundary, then 256 luma bytes, 64 Cb bytes, 64 Cr bytes. Clamp PCM samples to 1–255 (older decoders reject 0).

### 6.6 P-slice data (CAVLC)

- Loop: write `mb_skip_run` ue (the count of P_Skip MBs before the next coded MB), then the coded MB. At the end, write the last skip run if it is not zero.
- P_L0_16x16: mb_type ue 0; `mvd_l0` x and y (se, quarter-sample units, mvd = mv − mvp); `coded_block_pattern` me(v) (inter column of Table 9-4); if cbp > 0: `mb_qp_delta` se (always 0 in v1, one QP per frame); then residual.
- Residual (7.3.5.3): for each 8×8 luma block with its cbp bit set, four 4×4 blocks (16 coefficients each, zigzag). If chroma cbp ≥ 1: chroma DC for Cb then Cr (4 coefficients, nC = −1). If chroma cbp = 2: chroma AC, four blocks for Cb then four for Cr (15 coefficients).
- `residual_block_cavlc` (9.2): coeff_token (table selected by nC), trailing ones signs, levels with suffixLength rules, total_zeros, run_before.
- nC (9.2.1): from total_coeff of the left (A) and upper (B) 4×4 blocks. Both available → (nA + nB + 1) >> 1. One available → that value. None → 0. A P_Skip neighbor counts 0. An I_PCM neighbor counts 16. A neighbor outside the picture is not available.

### 6.7 Motion

- **MV prediction** (8.4.1.3): median of A, B, C. Use D when C is not available. Use the single-match rule when only one neighbor has refIdx 0. An intra (I_PCM) neighbor is "available, refIdx −1".
- **P_Skip vector** (8.4.1.1): mv = (0,0) if A or B is not available, or if A or B has refIdx 0 and mv (0,0). Else mv = median prediction. P_Skip uses the predicted vector, not always zero. This continues neighbor motion and is part of the smear look.
- **Luma interpolation** (8.4.2.2.1): 6-tap filter (1, −5, 20, 20, −5, 1) for half samples. Quarter samples are the rounded average of two neighbors.
- **Chroma interpolation** (8.4.2.2.2): 1/8-sample bilinear: `((8−xF)(8−yF)A + xF(8−yF)B + (8−xF)yF·C + xF·yF·D + 32) >> 6`.
- **Edge clamp**: reference sample coordinates outside the picture are clamped to the nearest edge sample (unrestricted MVs).
- **MV limits**: vertical range at levels 3.0–4.x is −256 to +255.75 samples. The search range setting (≤ 64) stays inside this.
- Motion precision setting: Full (MV multiple of 4), Half (multiple of 2), Quarter (any). The bitstream is the same format in all three cases. Only the encoder search changes.

### 6.8 Transform and quantization

- 4×4 forward core transform and quantization (8.5.12 inverse, standard forward pair). Encoder quant: `Z = sign(W)·((|W|·MF + f) >> qbits)`, `qbits = 15 + floor(QP/6)`, `f = (1 << qbits)/6` for inter blocks.
- Dequantization and inverse transform exactly as in 8.5.12 with flat scaling (LevelScale = 16 × normAdjust). Final rounding `(x + 32) >> 6`.
- Chroma DC: 2×2 Hadamard and the chroma DC dequant rule (8.5.11). Chroma QP from Table 8-15 (chroma_qp_index_offset = 0).
- **R-11** The encoder reconstruction calls the same dequant and inverse-transform functions as the decoder.

### 6.9 Level selection

Compute MBs per frame (coded size) and MBs per second (MBs × fps). Select the lowest level from this list that holds both: 3.0 (1620 MB, 40500 MB/s), 3.1 (3600, 108000), 3.2 (5120, 216000), 4.0 (8192, 245760). Bitrate limits are not enforced (I_PCM frames are large). Document this in the README.

### 6.10 Encoder mode decision (for each MB, P-picture)

1. **Skip test**: compute the P_Skip vector. Make the prediction. If all luma and chroma residual blocks quantize to zero **and** the SAD is below `skipThreshold`, code P_Skip. `skipThreshold` comes from the Skip bias setting (§7).
2. **Motion search** (luma only, SAD): start points = P_Skip vector, median predictor, (0,0), and the co-located vector of the previous frame. Do a small diamond search, then a large diamond if the cost is high, inside ±searchRange. Early stop below a threshold. Cost = SAD + λ·bits(mvd).
3. **Sub-sample refinement** when precision is Half or Quarter: test the 8 half positions around the best, then the 8 quarter positions (Quarter only). Use pre-computed half-sample planes for each reference frame.
4. **Heal** (only when Heal is Low or High): if best SAD / 256 > healThreshold, code I_PCM. Off → never.
5. Else code P_L0_16x16 with residual. Set cbp bits for blocks with nonzero coefficients.
6. Reconstruct the MB into the encoder reference.

Rate-distortion is simple in v1 (no RDO). Mode decision must be deterministic. The output bits depend only on the input frames and the settings.

---

## 7. Settings

Settings panel: open with the gear (top left). Values outside these ranges are not offered.

### 7.1 Session settings (locked at the first recorded frame)

| Setting | Values | Default | Notes |
|---|---|---|---|
| Aspect ratio | 1:1, 4:3, 3:2, 16:9 | 4:3 | Ratio bar, as in neocamera |
| Orientation | Vertical, Horizontal | from screen | Ratio bar button |
| Size (short side) | 360, 480, 720 | 480 | 720 is for fast devices |
| Frame rate | 15, 24, 30 | 30 | Target rate. Hint at 720 (D17) |

Frame-rate hint (D17): with size 720, the settings panel shows a small hint under the frame rate when the rate is more than the device can hold. Example text: "720 at 30 fps can drop frames on this device. 24 or 15 fps is safer." The hint does not block the selection. Phase 1 benchmark on Ryan's phone (Android, 8 cores): 30 fps at all 360 and 480 sizes; 960×720 24 fps (Fast, Default) or 15 fps (Max); 1280×720 15 fps.

Visible sizes (horizontal; swap for vertical): 360 → 360×360, 480×360, 540×360, 640×360. 480 → 480×480, 640×480, 720×480, 852×480. 720 → 720×720, 960×720, 1080×720, 1280×720.

### 7.2 Encoder settings (stored for each frame; can change while paused, not while recording)

| Setting | Range | Default | Effect on the look |
|---|---|---|---|
| Quality (QP) | 16–44 | 28 | High QP = coarse residual, more blocks. Low QP = cleaner detail in moving areas, larger files, more CPU. |
| Search range | ±8, ±16, ±32, ±64 | ±32 | Larger range = longer smears with fast motion. More CPU. |
| Motion precision | Full, Half, Quarter | Half | Full = blocky steps. Quarter = smooth flowing smear. |
| Skip bias | 0–100 | 50 | High = more P_Skip blocks, more old pixels stay. Low = more coded motion. |
| Heal | Off, Low, High | **Off** | Off = pure mosh. Low/High = intra blocks repair bad areas (partial mosh). |

All values make a datamosh. Heal Low/High makes a partial mosh, by design.

### 7.3 Display and device settings (change at any time)

| Setting | Values | Default |
|---|---|---|
| Mosh preview | On (decoded output), Off (raw source) | **On** |
| Mirror front camera | On, Off | **On** (encoded as displayed) |

Mirror applies at capture. A change while paused applies to the next clip. Mirror never applies to a file source.

### 7.4 Info section (read only)

Encoder load (average ms per frame against the frame budget), dropped frames (session and current clip), audio status, storage used and free (`navigator.storage.estimate()`).

- **R-12** While recording, the settings panel shows values but does not permit changes.
- **R-13** Store `{qp, searchRange, precision, skipBias, heal}` in each pause point and in each frame meta.

---

## 8. Recorder behavior

### 8.1 States

```
GATE ──start──► IDLE ──record──► RECORDING ──pause──► PAUSING ──flushed──► PAUSED
                 ▲                    ▲                                   │  │
                 │                    └──────────── record ───────────────┘  │
                 └── discard / revert to start ──────────────────────────────┘
PAUSED or IDLE ──► EXPORTING ──► back to previous state
PAUSED ──► REVIEW (player, history) ──► PAUSED
```

- IDLE: no frames. The viewfinder shows the live source. No overlay.
- RECORDING: capture → encode → decode. The viewfinder shows the decoded output (Mosh preview On) or the source (Off).
- PAUSING: capture stopped. Wait for the encoder queue to finish and the decoder to finish the last packet.
- PAUSED: the viewfinder shows the live source. The overlay shows the last decoded frame. The opacity slider is visible.

### 8.2 Capture

- **R-14** Frame timing: use `requestVideoFrameCallback` on the source `<video>` when available, else rAF. Capture when `now − lastCapture ≥ 1000/fps − 2 ms`.
- **R-15** Crop: center "cover" crop to the session aspect ratio, the same crop that the viewfinder shows. `createImageBitmap(video, sx, sy, sw, sh, {resizeWidth, resizeHeight, resizeQuality:'medium'})`. Transfer the bitmap to the encoder worker.
- **R-16** The encoder worker draws the bitmap on an OffscreenCanvas (mirrored when needed), reads the pixels, and converts to YUV 4:2:0.
- **R-17** Timestamps: session time in microseconds. Session time = end of previous clips + (frame time − clip start time). For a file, frame time = `mediaTime` from rVFC. For the camera, use rVFC `captureTime` or `expectedDisplayTime`, else `performance.now()`.

### 8.3 Frame drops (D10)

- **R-18** The encoder may have a maximum of 6 frames in flight (D19). When the capture is due and 6 frames are in flight, the app does not capture. It adds 1 to the drop count.
- **R-19** Only encoder drops count. A slow source (for example a camera at 15 fps in low light) is not a drop.
- **R-20** A dropped frame makes the previous frame longer in the timeline (variable frame rate). The app does not change settings automatically, because that changes the look.
- **R-21** Decoder preview frames may be skipped when the decoder is late. This does not change the file and is not reported.
- Warning UI: §11.3.

### 8.4 Pause

1. Stop the capture. Stop the audio capture at the same time.
2. Wait until the encoder finishes all frames in flight.
3. Wait until the decoder has decoded the last packet.
4. Copy the decoder reference picture (Y, U, V). Make a JPEG thumbnail.
5. Trim or pad the audio of this clip to the exact video clip length (§10.4).
6. Make a **pause point** (§12) and save it.
7. Draw the reference picture to the overlay canvas. Show the overlay and the slider (default 50%).

- **R-22** The overlay is a canvas with the same size, crop, and mirror state as the viewfinder. Thus the alignment is exact.
- **R-23** The overlay is visible only in PAUSED (D5).

### 8.5 Resume

1. Hide the overlay.
2. Tell the encoder: "new clip". The next frame is a **hidden I-frame** (all I_PCM). The encoder uses it as its reference. The packet is stored with type `hiddenI`.
3. All next frames are P-frames.
4. The decoder ignores the hidden frame. Its reference stays the moshed picture.

### 8.6 Interruptions

- **R-24** Page hidden (`visibilitychange`), camera track ended, or file ended → pause (not stop). Show a toast.
- **R-25** Request a wake lock while recording.
- **R-26** Warn when free storage is below 200 MB. Do not call `navigator.storage.persist()` (D18).

---

## 9. Export

### 9.1 Export sheet

Opened by the Export button (top right). Available in IDLE-with-frames and PAUSED. Not available while recording.

Options:

| Option | Values | Default |
|---|---|---|
| Mode | **Original (lossless, fast)**, Upscale (re-encode) | Original |
| Upscale size | 1080 short side; Sharp (nearest) or Smooth | 1080, Sharp |
| Cuts | For each cut: Mosh or Clean | All Mosh |

Then: progress bar, Cancel, and on finish: Share (iOS "Save Video") or Download. File name: `neomosh_YYYYMMDD_HHMMSS.mp4`.

### 9.2 Original mode: lossless remux (default, D12)

This is the efficient bake. It does not decode, does not re-encode, and does not play in real time. The exported picture is the same as our decoder output, bit for bit.

1. Read the frame packets from IndexedDB in sequence.
2. Select the frames to keep: all frames of type `idr` and `p`. For a cut set to **Clean**, also keep that cut's `hiddenI` frame.
3. For each kept frame, write the slice header with the correct `frame_num` (§6.4), add the slice data bits and the trailing bits, apply emulation prevention, and add a 4-byte length prefix (MP4 uses length-prefixed NAL units, not start codes).
4. Sample duration = next timestamp − this timestamp. Last frame = 1/fps. Timescale 90000. Carry the rounding error forward.
5. Mux with the MP4 muxer (§9.4). SPS and PPS go in `avcC`.

Clean cut note: with Clean, the hidden I-frame is shown, and the following P-frames apply to the correct reference. The result is a normal cut. The stream stays valid.

Known limit: the file has only one sync frame (frame 0), unless a cut is Clean. Players seek slowly in long files. Playback is normal. Write this in the README.

### 9.3 Upscale mode (re-encode)

1. Decode the kept frames with our decoder, in a worker.
2. Draw each frame scaled on a canvas (nearest or smooth).
3. Make a `VideoFrame` with the frame timestamp. Encode with `VideoEncoder` (H.264, `avc1.640028` or the best supported, about 16–20 Mbit/s at 1080p, keyframe every 2 s).
4. Mux with the same MP4 muxer. Use the `avcC` from `decoderConfig.description`.

This mode exists only when `VideoEncoder` supports H.264. The mosh is already in the pixels, so normal keyframes do no harm here.

### 9.4 MP4 muxer (our own code)

Layout: `ftyp` (major `isom`, compatible `isom iso2 avc1 mp41`), `moov` before `mdat` (compute all sample sizes first, then write the offsets), `mdat`.

`moov`: `mvhd`; video `trak` (`tkhd` with display size, `mdia` → `mdhd` timescale 90000, `hdlr vide`, `minf` → `vmhd`, `dinf/dref`, `stbl` → `stsd/avc1/avcC`, `stts`, `stss`, `stsc`, `stsz`, `stco` or `co64`); audio `trak` when audio exists (`smhd`, `stsd/mp4a/esds` with the AudioSpecificConfig, timescale = sample rate).

- **R-27** Build the file as a list of Blob parts. Do not make one large ArrayBuffer.
- **R-28** Use `co64` when the file is larger than 4 GB, else `stco`.
- **R-29** Mark only IDR frames (and Clean I-frames) in `stss`.

---

## 10. Audio (D11) — removed by D20

This section does not apply. It stays here only as a record.

### 10.1 Startup check

At the gate button tap (a user gesture):

1. Make the `AudioContext`.
2. Call `AudioEncoder.isConfigSupported({codec:'mp4a.40.2', sampleRate: ctx.sampleRate, numberOfChannels: 2, bitrate: 160000})`.
3. Supported → audio On. Not supported, no `AudioEncoder`, or microphone refused → audio Off for camera clips.

Show the result with the audio badge (§11.3). Do not show a dialog.

### 10.2 Capture

- AudioWorklet (module from a Blob URL) collects Float32 samples and posts blocks to the main thread. The main thread converts them to Int16, stereo interleaved, and saves chunks of about 1 s to IndexedDB.
- Camera source: microphone → worklet (mono copied to two channels).
- File source: `createMediaElementSource(fileVideo)` → worklet. Do **not** connect it to the speakers.
- The worklet runs only in RECORDING.

### 10.3 Export

Encode the PCM with `AudioEncoder` at export. Mux the AAC chunks. Storing PCM (not AAC) makes undo cuts exact.

### 10.4 Sync

- **R-30** (Not used: D20.) Video timestamps define the timeline. At each pause, trim or pad (silence) the clip audio to the exact video clip length.
- AAC priming delay (about 1024 samples): add an `elst` edit list in the audio track if the encoder reports it. This is polish (Phase 7).

---

## 11. User interface

Base: neocamera v1.5.0 CSS, colors, shutter, ratio bar, guide slider, toast, and gate. Remove the photo mode.

### 11.1 Layout

```
┌─────────────────────────────────────────┐
│ [⚙]      ● 00:12 · clip 3  [⚠ 7][🎤̸]  [Export] │  top bar
│ [Vertical] | 1:1  4:3  3:2  16:9        │  ratio bar (locked after start)
│ Guide ────────●──────── 50%            │  only in PAUSED
│ ┌─────────────────────────────────────┐ │
│ │                                     │ │
│ │   viewfinder canvas (decoded) or    │ │
│ │   source video; overlay canvas      │ │
│ │                                     │ │
│ └─────────────────────────────────────┘ │
│ File ──────●────────── 01:23 / 02:40    │  only in PAUSED with FILE source
│           CAMERA      FILE              │  source bar (mode bar in neocamera)
│ [thumb]        ( ● )            [flip]  │  controls
└─────────────────────────────────────────┘
```

- Top left: Settings (gear).
- Top center: recording pill (session time, clip number). Red dot blinks in RECORDING. In PAUSED the pill shows "PAUSED · clip N".
- Top center, right of the pill: status badges (§11.3).
- **Top right: Export** (D13).
- Bottom left: thumbnail of the last decoded frame. Tap → Review sheet (§11.4).
- Bottom center: shutter. Red circle = record/resume. Red rounded square = pause.
- **Bottom right: camera switch** (D13). Disabled in RECORDING and with the FILE source.
- Source bar: CAMERA / FILE, in the place of the PHOTO / VIDEO labels. Available in IDLE and PAUSED.

### 11.2 Viewfinder

- RECORDING + Mosh preview On: draw each decoded `ImageBitmap` on the viewfinder canvas.
- RECORDING + Mosh preview Off, IDLE, PAUSED: show the source `<video>` with the same crop and mirror state as the capture.
- Tap-to-focus, hold-to-lock, and exposure drag from neocamera stay, for the camera source only.

### 11.3 Status badges (D10, D11)

Small, quiet icons. No dialogs. Tap a badge to show a toast with the detail.

| Badge | Shows when | Toast text |
|---|---|---|
| Amber ⚠ + count | Session drop count > 0 | "The encoder dropped N frames. Use a smaller size, a smaller search range, or a lower frame rate." |
| Amber ⚠ pulses once | A new drop happens | — |
| (Removed by D20) Grey mic with slash | Audio Off | "No audio. This browser has no AAC encoder." or "No audio. The microphone is off." |

The settings Info section (§7.4) shows the same data in full.

### 11.4 Review sheet (history and undo, D14)

- A player for the full session, made with our decoder. Play, pause, scrub.
- Scrub uses checkpoints: the pause point snapshots, plus decoder snapshots every 2 s that the player makes during playback (in RAM only).
- A history strip: one card for each pause point (thumbnail, clip number, session time, drop count for that clip). Card 0 is "Start".
- Tap a card → "Revert to here". A confirm sheet (custom UI, not `confirm()`) says: "This deletes all clips after this point. You cannot undo this."
- Revert to card N: §12.3. Then the app goes to PAUSED at that point (or IDLE for "Start").
- "New video" button: discards the session after a confirm sheet.

### 11.5 File source (D15)

1. Tap FILE (in IDLE or PAUSED). A file picker opens (`accept="video/*"`).
2. The file plays in a hidden `<video>` (muted for the speakers, `playsinline`). The viewfinder shows it with the session crop. It is not mirrored.
3. In PAUSED (or IDLE), a file scrubber selects the start point. The overlay stays visible above it.
4. Record: the file plays at normal speed (1×). Capture works the same as for the camera.
5. Pause: the file pauses at the same time.
6. File end: automatic pause and the toast "The file ended."
7. Tap CAMERA to go back to the camera. Keep the camera stream open while the file source is used.

- **R-31** The encoder gets the same messages for camera and file frames. It cannot tell the source.
- **R-32** In v1, a file plays at 1×. A slow device drops frames, the same as with the camera. (Future: a no-drop mode with slower playback, §15.)

### 11.6 Gate and session restore

- The gate is the same as neocamera. The button text is "Start".
- If IndexedDB has a session, the gate also shows "Continue last video" and "Start new".
- Continue: load the last pause point and its reference into the decoder → PAUSED. If frames exist after the last pause point (the app closed while recording), decode them from that point to rebuild the reference, then make a new pause point.

---

## 12. Storage (IndexedDB)

Database `neomosh`, version 1.

| Store | Key | Value |
|---|---|---|
| `sessions` | `id` | `{id, created, w, h, codedW, codedH, fps, aspect, orient, level, audio:bool, sampleRate}` |
| `frames` | `[sessionId, index]` | `{type:'idr'|'p'|'hiddenI', clip, tsUs, qp, bits:Uint8Array, bitLen}` |
| `points` | `[sessionId, n]` | `{frameIndex, tsUs, audioSamples, refY, refU, refV, thumb:Blob, settings, drops}` |
| `audio` | `[sessionId, chunk]` | `{startSample, pcm:Int16Array}` |

- `points[n].frameIndex` = index of the first frame after point n. Point 0 = start (frameIndex 0, no reference).
- **R-33** Write frames in batches about every 1 s (one transaction). Keep only meta in RAM.
- **R-34** The export reads frames from IndexedDB in sequence. It does not load all frames into RAM.

### 12.3 Revert to point N

1. Delete frames with index ≥ `points[N].frameIndex`.
2. Delete points > N.
3. Delete audio after `points[N].audioSamples` (trim the chunk that crosses it).
4. Reset the decoder reference to `refY/U/V` of point N.
5. Reset the encoder: the next frame is a hidden I-frame. For N = 0, the next frame is the IDR (the session restarts; session settings unlock).
6. Set the encoder settings to `points[N].settings`.

Estimated size at 480p, 30 fps, QP 28: about 15–40 MB per minute of video, plus 11.5 MB per minute of audio, plus about 0.5 MB per pause point.

---

## 13. Verification (mandatory)

### 13.1 Node test harness with FFmpeg (Phases 1–2)

For each test case: run the encoder in Node on synthetic YUV frames, write an Annex B `.264` file (start codes + SPS + PPS + slices) and an `.mp4` file, and dump our decoder output as raw YUV.

Checks:

1. `ffmpeg -v error -i out.264 -f null -` → **no output** (no errors, no warnings).
2. `ffmpeg -v error -i out.mp4 -f null -` → no output.
3. `ffmpeg -i out.mp4 -f rawvideo -pix_fmt yuv420p ffdec.yuv` → **byte-identical** to our decoder dump.
4. Our encoder reconstruction (for non-hidden frames before the first cut) is byte-identical to our decoder output.
5. `ffprobe -show_frames` → correct frame count, frame types, and timestamps.

Test cases (synthetic content: moving gradients, moving noise, a moving square on a flat field, a pan, a zoom, a scene change):

- Each QP in {16, 22, 28, 34, 40, 44}.
- Each precision (Full, Half, Quarter).
- Each search range.
- Heal Off, Low, High.
- MVs that point outside the picture.
- Each visible size in §7.1, both orientations (tests cropping).
- One cut, many cuts, a cut on frame 1 of a clip.
- Each cut as Mosh and as Clean.
- Variable frame durations (drops).
- A revert, then more clips.

### 13.2 Mosh check

For a cut: the decoded frame after the cut must equal "old picture moved by the new motion", not the new scene. Test: a still old scene plus a new scene with one moving square. After the cut, only the area along the square path changes. The rest stays the old picture.

### 13.3 In-browser self-test (hidden debug setting)

Export a short session, decode it with `VideoDecoder` (`copyTo` in I420 format), and compare with our decoder output. Report "identical" or the first frame that differs. Run this on iPhone Safari (hardware decoder) and Android Chrome.

### 13.4 Device tests

Play the exported files in: iOS Photos, iOS Files/QuickTime, macOS QuickTime, VLC, Chrome, Firefox, and an editor (Final Cut Pro or CapCut). Check: plays to the end, no freeze, no grey/green blocks, audio in sync.

### 13.5 Performance benchmark page

A debug page measures encoder ms per frame and decoder ms per frame for each size and setting. Run it on Ryan's phone in Phase 1, before the UI work.

Estimated cost at 640×480: 1200 MBs × about 30 SAD tests × 256 samples ≈ 9 M operations per frame for motion search. At 30 fps this is about 280 M/s. This is possible in a worker with typed arrays, but it can be at the limit on older phones. Quarter precision and ±64 add cost.

---

## 14. Phases and acceptance criteria

### Phase 0 — Repository

- Layout from §5.2, `tools/build.mjs`, a test runner, a README draft.
- Done when: `node tools/build.mjs` makes `dist/neomosh-v0.1.0.html` from stub modules, and `node tests/run.mjs` runs.

### Phase 1 — Codec core (highest risk; do this first)

Steps, each with the §13.1 checks:

1. Bit I/O, Exp-Golomb, emulation prevention, SPS, PPS, slice header, Annex B writer.
2. IDR of all I_PCM. Then P-frames of all P_Skip.
3. P_L0_16x16, full-sample MVs, no residual (cbp 0).
4. Residual: transform, quant, CAVLC, chroma DC/AC.
5. Half and quarter samples, luma and chroma interpolation.
6. Motion search and mode decision (§6.10), Skip bias.
7. Heal (I_PCM in P).
8. Hidden I-frame and cuts. Mosh check (§13.2).
9. Benchmark page (§13.5).

Done when: all §13.1 and §13.2 tests pass, and Ryan has run the benchmark on his phone.

### Phase 2 — MP4 muxer and lossless export

- MP4 muxer (video only), remux with header rewrite, Mosh/Clean cuts, variable durations.
- Done when: the §13.1 MP4 checks pass, and the file plays in iOS Photos and QuickTime.

### Phase 3 — Recorder

- neocamera UI port (§11), capture (§8.2), workers, live decoded viewfinder, pause/overlay/resume, drop counter and badge, IndexedDB frame storage, Export button with the Original mode.
- Done when: Ryan can record, pause, align, resume, see the mosh live, and export a valid MP4 on his phone.

### Phase 4 — History, review, restore

- Pause points, Review sheet, revert to any point, New video, session restore at the gate.
- Done when: revert to each point works, and the export after a revert passes the §13.1 checks.

### Phase 5 — File source

- Source bar, file picker, file scrubber, file end handling.
- Done when: a session can mix camera and file clips in any order, and the export is valid.

### Phase 6 — Audio (removed by D20)

- AAC check, audio badge, worklet capture (mic and file), PCM storage, trim/pad, AAC encode at export, audio track in the muxer.
- Done when: the export has audio in sync at each cut on iPhone and Android, and the no-AAC path shows the badge and exports video only.

### Phase 7 — Settings and polish

- Full settings panel (§7), Info section, Upscale export, AAC edit list, storage warnings, in-browser self-test, README.
- Done when: all settings work in their full ranges, and §13.3 and §13.4 pass.

---

## 15. Future ideas (not in v0.1.0)

- **Bloom**: repeat one P-frame many times (a held button). It is a bitstream operation, not a pixel effect, and the stream stays valid.
- Smaller partitions (16×8, 8×16, 8×8) for finer smears.
- Deblocking filter as a setting (softer look; the decoder needs the 8.7 filter).
- Intra 16×16 prediction instead of I_PCM (smaller files).
- File no-drop mode: slow the file playback when the encoder is late, and use media time for the timestamps.
- Export and import of a session file.

---

## 16. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| CAVLC or MV prediction error | FFmpeg errors, or output differs | Phase 1 step-by-step FFmpeg bit-exact tests |
| Encoder too slow on a phone | Drops, jumpy motion | Benchmark first, drop badge, smaller presets |
| Encoder/decoder mismatch | Noise that is not mosh | Shared reconstruction code (R-11), test 13.1 #4 |
| iOS storage limits or eviction | Lost session | Warnings, frequent writes (no `storage.persist()`, D18) |
| No AAC encoder | No audio | Badge, video-only export |
| One sync frame | Slow seeking in long files | README note; Clean cuts add sync frames |
| Large I_PCM frames above level bitrate | A strict decoder could complain | Tested in §13.4; v2 can use Intra 16×16 |

---

## 17. README content (when shipped)

GitHub format. No license section. Short. Sections: what neomosh is, how to use it (record, pause, align, resume, file source, history, export), settings table, browser support, known limits (needs movement, slow seeking, drops on slow devices, no audio without AAC encoder).
