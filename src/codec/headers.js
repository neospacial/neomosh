// SPS, PPS, and slice header writers, the NAL unit wrapper, the Annex B writer, and the frame
// selection for export. References: H.264 7.3.1, 7.3.2.1, 7.3.2.2, 7.3.3, E.1.1; plan §6.2 - §6.4.

import { BitWriter, BitReader, rbspToEbsp, ebspToRbsp } from './bitio.js';

export const NAL_SLICE = 1;
export const NAL_IDR = 5;
export const NAL_SPS = 7;
export const NAL_PPS = 8;

// Plan §6.9. [level_idc, max MBs per frame, max MBs per second].
const LEVELS = [
  [30, 1620, 40500],
  [31, 3600, 108000],
  [32, 5120, 216000],
  [40, 8192, 245760],
];

export function chooseLevel(codedW, codedH, fps) {
  const mbs = (codedW >> 4) * (codedH >> 4);
  for (const [idc, fs, mbps] of LEVELS) if (mbs <= fs && mbs * fps <= mbps) return idc;
  throw new Error(`No level for ${codedW}x${codedH} at ${fps} fps`);
}

export function align16(v) {
  return (v + 15) & ~15;
}

// Stream parameters: visible size w x h (even numbers), frame rate for the level.
export function streamParams(w, h, fps) {
  if (w & 1 || h & 1) throw new Error('Visible size must be even');
  const codedW = align16(w);
  const codedH = align16(h);
  return { w, h, codedW, codedH, fps, level: chooseLevel(codedW, codedH, fps) };
}

function nalUnit(type, rbsp) {
  const ebsp = rbspToEbsp(rbsp);
  const out = new Uint8Array(ebsp.length + 1);
  out[0] = (3 << 5) | type; // forbidden_zero_bit 0, nal_ref_idc 3.
  out.set(ebsp, 1);
  return out;
}

export function spsNal(p) {
  const bw = new BitWriter(64);
  bw.u(8, 66); // profile_idc: Baseline
  bw.u(8, 0b11000000); // constraint_set0_flag = 1, constraint_set1_flag = 1 (Constrained Baseline)
  bw.u(8, p.level);
  bw.ue(0); // seq_parameter_set_id
  bw.ue(12); // log2_max_frame_num_minus4: frame_num has 16 bits
  bw.ue(2); // pic_order_cnt_type
  bw.ue(1); // max_num_ref_frames
  bw.u(1, 0); // gaps_in_frame_num_value_allowed_flag
  bw.ue((p.codedW >> 4) - 1);
  bw.ue((p.codedH >> 4) - 1);
  bw.u(1, 1); // frame_mbs_only_flag
  bw.u(1, 1); // direct_8x8_inference_flag
  const crop = p.codedW !== p.w || p.codedH !== p.h;
  bw.u(1, crop ? 1 : 0);
  if (crop) {
    bw.ue(0);
    bw.ue((p.codedW - p.w) >> 1);
    bw.ue(0);
    bw.ue((p.codedH - p.h) >> 1);
  }
  bw.u(1, 1); // vui_parameters_present_flag
  bw.u(1, 0); // aspect_ratio_info_present_flag
  bw.u(1, 0); // overscan_info_present_flag
  bw.u(1, 1); // video_signal_type_present_flag
  bw.u(3, 5); // video_format: unspecified
  bw.u(1, 0); // video_full_range_flag: limited range
  bw.u(1, 1); // colour_description_present_flag
  bw.u(8, 1); // colour_primaries: BT.709
  bw.u(8, 1); // transfer_characteristics: BT.709
  bw.u(8, 1); // matrix_coefficients: BT.709
  bw.u(1, 0); // chroma_loc_info_present_flag
  bw.u(1, 0); // timing_info_present_flag
  bw.u(1, 0); // nal_hrd_parameters_present_flag
  bw.u(1, 0); // vcl_hrd_parameters_present_flag
  bw.u(1, 0); // pic_struct_present_flag
  bw.u(1, 1); // bitstream_restriction_flag
  bw.u(1, 1); // motion_vectors_over_pic_boundaries_flag
  bw.ue(0); // max_bytes_per_pic_denom
  bw.ue(0); // max_bits_per_mb_denom
  bw.ue(16); // log2_max_mv_length_horizontal
  bw.ue(16); // log2_max_mv_length_vertical
  bw.ue(0); // max_num_reorder_frames
  bw.ue(1); // max_dec_frame_buffering
  bw.trailing();
  return nalUnit(NAL_SPS, bw.toBytes());
}

export function ppsNal() {
  const bw = new BitWriter(16);
  bw.ue(0); // pic_parameter_set_id
  bw.ue(0); // seq_parameter_set_id
  bw.u(1, 0); // entropy_coding_mode_flag: CAVLC
  bw.u(1, 0); // bottom_field_pic_order_in_frame_present_flag
  bw.ue(0); // num_slice_groups_minus1
  bw.ue(0); // num_ref_idx_l0_default_active_minus1
  bw.ue(0); // num_ref_idx_l1_default_active_minus1
  bw.u(1, 0); // weighted_pred_flag
  bw.u(2, 0); // weighted_bipred_idc
  bw.se(0); // pic_init_qp_minus26
  bw.se(0); // pic_init_qs_minus26
  bw.se(0); // chroma_qp_index_offset
  bw.u(1, 1); // deblocking_filter_control_present_flag
  bw.u(1, 0); // constrained_intra_pred_flag
  bw.u(1, 0); // redundant_pic_cnt_present_flag
  bw.trailing();
  return nalUnit(NAL_PPS, bw.toBytes());
}

// Slice header (plan §6.4). h = { idr: bool, intra: bool, frameNum, qp }.
export function writeSliceHeader(bw, h) {
  bw.ue(0); // first_mb_in_slice
  bw.ue(h.intra ? 7 : 5); // slice_type
  bw.ue(0); // pic_parameter_set_id
  bw.u(16, h.frameNum & 0xffff); // frame_num
  if (h.idr) bw.ue(0); // idr_pic_id
  if (!h.intra) {
    bw.u(1, 0); // num_ref_idx_active_override_flag
    bw.u(1, 0); // ref_pic_list_modification_flag_l0
  }
  if (h.idr) {
    bw.u(1, 0); // no_output_of_prior_pics_flag
    bw.u(1, 0); // long_term_reference_flag
  } else {
    bw.u(1, 0); // adaptive_ref_pic_marking_mode_flag
  }
  bw.se(h.qp - 26); // slice_qp_delta
  bw.ue(1); // disable_deblocking_filter_idc
}

// Slice header form of a stored frame. A hidden I-frame is written as a non-IDR I picture.
export function headerForFrame(frame, frameNum) {
  return { idr: frame.type === 'idr', intra: frame.type !== 'p', frameNum, qp: frame.qp };
}

// The bit length of the slice header of a frame. It does not depend on frame_num (fixed 16 bits).
export function sliceHeaderBits(frame) {
  const bw = new BitWriter(32);
  writeSliceHeader(bw, headerForFrame(frame, 0));
  return bw.pos;
}

// Make the slice NAL unit of a stored frame with the given frame_num (plan §6.4, §9.2 step 3).
// frame = { type: 'idr' | 'p' | 'hiddenI', qp, bits, bitLen, hdrBits }.
export function sliceNal(frame, frameNum) {
  const bw = new BitWriter(((frame.bitLen + 7) >> 3) + 32);
  writeSliceHeader(bw, headerForFrame(frame, frameNum));
  if (bw.pos !== frame.hdrBits) throw new Error('Slice header length differs from the stored length');
  bw.appendBits(frame.bits, frame.bitLen);
  bw.trailing();
  return nalUnit(frame.type === 'idr' ? NAL_IDR : NAL_SLICE, bw.toBytes());
}

// Select the frames for export (plan §9.2 step 2) and give each one its frame_num.
// cuts: array of 'mosh' | 'clean' for each cut (a cut = a hidden I-frame), or one value for all.
// Returns a function: frame -> { frameNum, key } for a kept frame, or null for a dropped frame.
export function frameSelector(cuts = 'mosh') {
  let cut = 0;
  let frameNum = 0;
  return (f) => {
    if (f.type === 'hiddenI') {
      const mode = typeof cuts === 'string' ? cuts : cuts[cut] || 'mosh';
      cut++;
      if (mode !== 'clean') return null;
    } else if (f.type === 'idr') {
      frameNum = 0;
    }
    const k = { frameNum, key: f.type !== 'p' };
    frameNum = (frameNum + 1) & 0xffff;
    return k;
  };
}

// The kept frames of a frame list. Yields { frame, index, frameNum, key }.
export function* keptFrames(frames, cuts = 'mosh') {
  const select = frameSelector(cuts);
  let index = 0;
  for (const frame of frames) {
    const k = select(frame);
    if (k) yield { frame, index, frameNum: k.frameNum, key: k.key };
    index++;
  }
}

// Annex B byte stream: SPS, PPS, then the kept slices, each with a 4-byte start code.
export function annexB(params, frames, cuts = 'mosh') {
  const nals = [spsNal(params), ppsNal()];
  for (const k of keptFrames(frames, cuts)) nals.push(sliceNal(k.frame, k.frameNum));
  let len = 0;
  for (const n of nals) len += n.length + 4;
  const out = new Uint8Array(len);
  let o = 0;
  for (const n of nals) {
    out[o + 3] = 1;
    out.set(n, o + 4);
    o += n.length + 4;
  }
  return out;
}

// Split an Annex B stream into NAL units (without start codes).
export function splitAnnexB(bytes) {
  const nals = [];
  let i = 0;
  let start = -1;
  const n = bytes.length;
  while (i + 2 < n) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && bytes[end - 1] === 0) end--;
        nals.push(bytes.subarray(start, end));
      }
      i += 3;
      start = i;
    } else i++;
  }
  if (start >= 0) nals.push(bytes.subarray(start, n));
  return nals;
}

// Parse a NAL unit of a stream that this module wrote. For a slice, returns the header fields and a
// BitReader at the first bit of slice_data().
export function parseNal(nal) {
  const type = nal[0] & 31;
  const rbsp = ebspToRbsp(nal.subarray(1));
  if (type !== NAL_SLICE && type !== NAL_IDR) return { type, rbsp };
  // The length of slice_data() is the RBSP length minus the rbsp_slice_trailing_bits.
  let last = rbsp.length - 1;
  while (last >= 0 && rbsp[last] === 0) last--;
  const low = rbsp[last] & -rbsp[last]; // the rbsp_stop_one_bit
  const trailingPos = last * 8 + (7 - (31 - Math.clz32(low)));
  const br = new BitReader(rbsp, trailingPos);
  const firstMb = br.ue();
  const sliceType = br.ue();
  const ppsId = br.ue();
  const frameNum = br.u(16);
  const idr = type === NAL_IDR;
  if (idr) br.ue();
  const intra = sliceType % 5 === 2;
  if (!intra) {
    if (br.u1()) throw new Error('num_ref_idx_active_override_flag not supported');
    if (br.u1()) throw new Error('ref_pic_list_modification not supported');
  }
  if (idr) {
    br.u1();
    br.u1();
  } else if (br.u1()) throw new Error('adaptive_ref_pic_marking not supported');
  const qp = 26 + br.se();
  const dbf = br.ue();
  if (dbf !== 1) throw new Error('Deblocking filter not supported');
  return { type, firstMb, sliceType, ppsId, frameNum, idr, intra, qp, reader: br };
}
