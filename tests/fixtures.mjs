// Fixture builders — hand-rolled WAV files, valid and deliberately broken.
import { Buffer } from "node:buffer";

function chunk(id, body, sizeOverride = null) {
  const padded = body.length + (body.length & 1);
  const b = Buffer.alloc(8 + padded);
  b.write(id, 0, "latin1");
  b.writeUInt32LE(sizeOverride == null ? body.length : sizeOverride, 4);
  body.copy(b, 8);
  return b;
}

function fmtBody({
  formatTag = 1,
  channels = 1,
  sampleRate = 8000,
  bitsPerSample = 16,
  byteRate = null,
  blockAlign = null,
  cbSize = null,
  validBits = null,
  channelMask = 0,
  subFormatTag = 1,
} = {}) {
  const bps = Math.max(1, Math.ceil(bitsPerSample / 8));
  const align = blockAlign ?? channels * bps;
  const rate = byteRate ?? sampleRate * align;
  const isExt = formatTag === 0xfffe;
  const size = isExt ? 40 : cbSize == null ? 16 : 18;
  const b = Buffer.alloc(size);
  b.writeUInt16LE(formatTag, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(sampleRate, 4);
  b.writeUInt32LE(rate, 8);
  b.writeUInt16LE(align, 12);
  b.writeUInt16LE(bitsPerSample, 14);
  if (size >= 18) b.writeUInt16LE(isExt ? 22 : (cbSize ?? 0), 16);
  if (isExt) {
    b.writeUInt16LE(validBits ?? bitsPerSample, 18);
    b.writeUInt32LE(channelMask, 20);
    b.writeUInt16LE(subFormatTag, 24);
    Buffer.from([
      0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71,
    ]).copy(b, 26);
  }
  return b;
}

// Corruption knobs let tests break specific invariants while keeping the rest valid.
export function buildWav({
  fmt = {},
  frames = 8,
  data = null,
  fact = null,
  preChunks = [],
  midChunks = [],
  postChunks = [],
  noFmt = false,
  noData = false,
  riffSizeOverride = null,
  dataSizeOverride = null,
  truncate = 0,
  trailing = null,
} = {}) {
  const f = {
    formatTag: 1,
    channels: 1,
    sampleRate: 8000,
    bitsPerSample: 16,
    ...fmt,
  };
  const bps = Math.max(1, Math.ceil(f.bitsPerSample / 8));
  const frameBytes = f.channels * bps;
  const body = data ?? Buffer.alloc(frames * frameBytes);

  const parts = [];
  for (const c of preChunks) parts.push(chunk(c.id, c.body));
  if (!noFmt) parts.push(chunk("fmt ", fmtBody(f)));
  if (fact != null) {
    const fb = Buffer.alloc(4);
    fb.writeUInt32LE(fact, 0);
    parts.push(chunk("fact", fb));
  }
  for (const c of midChunks) parts.push(chunk(c.id, c.body));
  if (!noData) parts.push(chunk("data", body, dataSizeOverride));
  for (const c of postChunks)
    parts.push(chunk(c.id, c.body, c.sizeOverride ?? null));

  const payload = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(riffSizeOverride ?? payload.length + 4, 4);
  header.write("WAVE", 8, "latin1");

  let out = Buffer.concat([header, payload]);
  if (trailing) out = Buffer.concat([out, trailing]);
  if (truncate > 0) out = out.subarray(0, out.length - truncate);
  return out;
}

/** RF64 file: 64-bit sizes live in the ds64 chunk; 32-bit fields are 0xFFFFFFFF. */
export function buildRf64({
  fmt = {},
  frames = 8,
  factPlaceholder = false,
} = {}) {
  const f = {
    formatTag: 1,
    channels: 1,
    sampleRate: 8000,
    bitsPerSample: 16,
    ...fmt,
  };
  const bps = Math.max(1, Math.ceil(f.bitsPerSample / 8));
  const body = Buffer.alloc(frames * f.channels * bps);

  const ds64Body = Buffer.alloc(28);
  const fmtChunk = chunk("fmt ", fmtBody(f));
  const factBody = Buffer.alloc(4);
  factBody.writeUInt32LE(0xffffffff, 0); // per spec, real count lives in ds64.sampleCount
  const factChunk = factPlaceholder ? chunk("fact", factBody) : Buffer.alloc(0);
  const dataChunk = chunk("data", body, 0xffffffff);
  const payload = Buffer.concat([
    chunk("ds64", ds64Body),
    fmtChunk,
    factChunk,
    dataChunk,
  ]);

  ds64Body.writeBigUInt64LE(BigInt(payload.length + 4), 0); // riff size
  ds64Body.writeBigUInt64LE(BigInt(body.length), 8); // data size
  ds64Body.writeBigUInt64LE(BigInt(frames), 16); // sample count
  // Rebuild with the ds64 body now filled in.
  const finalPayload = Buffer.concat([
    chunk("ds64", ds64Body),
    fmtChunk,
    factChunk,
    dataChunk,
  ]);

  const header = Buffer.alloc(12);
  header.write("RF64", 0, "latin1");
  header.writeUInt32LE(0xffffffff, 4);
  header.write("WAVE", 8, "latin1");
  return Buffer.concat([header, finalPayload]);
}

export function pcm16(samples) {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) =>
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2),
  );
  return b;
}

export function pcm16Sine({
  frames = 8000,
  rate = 8000,
  freq = 100,
  amp = 30000,
} = {}) {
  const s = new Array(frames);
  for (let i = 0; i < frames; i++)
    s[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return { fmt: { sampleRate: rate, bitsPerSample: 16 }, data: pcm16(s) };
}

export function listInfoBody(tags, encoding = "latin1") {
  const parts = [Buffer.from("INFO", "latin1")];
  for (const [id, text] of Object.entries(tags)) {
    const t = Buffer.from(text + "\0", encoding);
    parts.push(chunk(id, t));
  }
  return Buffer.concat(parts);
}

export const blob = (buf) => new Blob([buf]);
