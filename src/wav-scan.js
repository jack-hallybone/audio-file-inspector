// Streaming scan of the data chunk in 4 MiB slices, so peak memory is one slice however large the file.

import { pcmCodec } from "./wav-parser.js";

const SLICE_TARGET = 4 * 1024 * 1024;

// G.711 decoders, per the classic Sun Microsystems g711.c reference.
export function mulawToInt(u) {
  u = ~u & 0xff;
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return u & 0x80 ? 0x84 - t : t - 0x84;
}

export function alawToInt(a) {
  a ^= 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else t = (t + 0x108) << (seg - 1);
  return a & 0x80 ? t : -t;
}

function sampleReader(kind) {
  switch (kind) {
    case "u8":
      return (v, o) => (v.getUint8(o) - 128) / 128;
    case "s16":
      return (v, o) => v.getInt16(o, true) / 32768;
    case "s24":
      return (v, o) => {
        const b =
          v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16);
        return ((b << 8) >> 8) / 8388608;
      };
    case "s32":
      return (v, o) => v.getInt32(o, true) / 2147483648;
    case "f32":
      return (v, o) => v.getFloat32(o, true);
    case "f64":
      return (v, o) => v.getFloat64(o, true);
    case "mulaw":
      return (v, o) => mulawToInt(v.getUint8(o)) / 32768;
    case "alaw":
      return (v, o) => alawToInt(v.getUint8(o)) / 32768;
    default:
      return null;
  }
}

// Every reference value is a dyadic rational, exactly representable in float64, so these equality checks are precise, not approximate.
function fullScaleTest(kind) {
  switch (kind) {
    case "u8":
      return (x) => x === -1 || x === 127 / 128;
    case "s16":
      return (x) => x === -1 || x === 32767 / 32768;
    case "s24":
      return (x) => x === -1 || x === 8388607 / 8388608;
    case "s32":
      return (x) => x === -1 || x === 2147483647 / 2147483648;
    case "f32":
    case "f64":
      return (x) => Math.abs(x) >= 1;
    case "mulaw":
      return (x) => Math.abs(x) >= 32124 / 32768;
    case "alaw":
      return (x) => Math.abs(x) >= 32256 / 32768;
    default:
      return null;
  }
}

// Resolves null when cancelled; otherwise the same shape computeWaveform returns.
export async function scanAudio(
  blob,
  parsed,
  { columns = 1200, onProgress, isCancelled } = {},
) {
  const s = parsed && parsed.summary;
  if (!s || s.dataOffset == null) return null;
  const codec = pcmCodec(s);
  // frameBytes is null when the header is self-inconsistent, so the scan is refused rather than guess frame boundaries.
  if (!codec || !s.frameBytes || !s.channels || !s.sampleRate) return null;

  const bps = codec.bytesPerSample;
  const frameBytes = s.frameBytes;
  const totalFrames = Math.floor((s.availableDataBytes ?? 0) / frameBytes);
  if (totalFrames <= 0) return null;

  const read = sampleReader(codec.kind);
  const isFull = fullScaleTest(codec.kind);
  const mins = new Float32Array(columns).fill(Infinity);
  const maxs = new Float32Array(columns).fill(-Infinity);
  let peak = 0;
  let sumSq = 0;
  let fullScaleCount = 0;

  const framesPerSlice = Math.max(1, Math.floor(SLICE_TARGET / frameBytes));
  const start = s.dataOffset;
  let frame = 0;

  while (frame < totalFrames) {
    if (isCancelled && isCancelled()) return null;
    const n = Math.min(framesPerSlice, totalFrames - frame);
    const view = new DataView(
      await blob
        .slice(start + frame * frameBytes, start + (frame + n) * frameBytes)
        .arrayBuffer(),
    );
    for (let i = 0; i < n; i++) {
      const col = Math.min(
        columns - 1,
        Math.floor(((frame + i) * columns) / totalFrames),
      );
      const base = i * frameBytes;
      for (let c = 0; c < s.channels; c++) {
        const o = base + c * bps;
        const x = read(view, o);
        if (x < mins[col]) mins[col] = x;
        if (x > maxs[col]) maxs[col] = x;
        const a = Math.abs(x);
        if (a > peak) peak = a;
        sumSq += x * x;
        if (isFull(x)) fullScaleCount++;
      }
    }
    frame += n;
    if (onProgress) onProgress(frame / totalFrames);
  }

  for (let i = 0; i < columns; i++) {
    if (mins[i] === Infinity) {
      mins[i] = 0;
      maxs[i] = 0;
    }
  }
  const rms = Math.sqrt(sumSq / (totalFrames * s.channels));
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  return {
    columns,
    mins,
    maxs,
    frames: totalFrames,
    channels: s.channels,
    peak,
    peakDb: db(peak),
    rmsDb: db(rms),
    fullScaleCount,
  };
}
