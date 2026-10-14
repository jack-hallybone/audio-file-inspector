// RIFF/WAVE header parser and integrity checker, reading via Blob.slice() so only chunk headers reach memory, however large the file.

const WAVE_FORMATS = {
  0x0001: "PCM (integer)",
  0x0002: "Microsoft ADPCM",
  0x0003: "IEEE float",
  0x0006: "A-law",
  0x0007: "µ-law",
  0x0011: "IMA ADPCM",
  0x0031: "GSM 6.10",
  0x0050: "MPEG-1 audio",
  0x0055: "MP3",
  0x0092: "Dolby AC-3 (SPDIF)",
  0xfffe: "Extensible",
};

const INFO_TAGS = {
  INAM: "Title",
  IART: "Artist",
  IPRD: "Album",
  ICRD: "Date",
  IGNR: "Genre",
  ICMT: "Comment",
  ISFT: "Software",
  IENG: "Engineer",
  ICOP: "Copyright",
  ISBJ: "Subject",
  ITRK: "Track",
};

// Fixed tail of every standard WAVE_FORMAT_EXTENSIBLE subformat GUID (xxxxxxxx-0000-0010-8000-00AA00389B71):
const KSDATA_GUID_TAIL = [
  0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b,
  0x71,
];

const MAX_CHUNKS = 512;

function formatName(tag) {
  if (tag == null) return "unknown";
  return (
    WAVE_FORMATS[tag] || `unknown (0x${tag.toString(16).padStart(4, "0")})`
  );
}

async function readAt(blob, offset, length) {
  const end = Math.min(offset + length, blob.size);
  if (end <= offset) return new DataView(new ArrayBuffer(0));
  return new DataView(await blob.slice(offset, end).arrayBuffer());
}

function fourcc(view, off) {
  let s = "";
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(off + i));
  return s;
}

function isChunkId(id) {
  return /^[\x20-\x7e]{4}$/.test(id);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

// RIFF INFO/BWF text carries no declared encoding — UTF-8 is tried first (safe for ASCII, correct for real UTF-8), falling back to byte-for-byte Latin-1.
function asciiz(view, off, len) {
  const bytes = [];
  for (let i = 0; i < len && off + i < view.byteLength; i++) {
    const c = view.getUint8(off + i);
    if (c === 0) break;
    bytes.push(c);
  }
  const raw = Uint8Array.from(bytes);
  try {
    return utf8.decode(raw).trim();
  } catch {
    return Array.from(raw, (c) => String.fromCharCode(c))
      .join("")
      .trim();
  }
}

function parseFmt(view, chunkSize, add) {
  if (chunkSize < 16 || view.byteLength < 16) {
    add(
      "error",
      "ERR_FMT_SHORT",
      `fmt chunk is ${chunkSize} bytes — at least 16 are required; header is unusable.`,
    );
    return null;
  }
  const fmt = {
    formatTag: view.getUint16(0, true),
    channels: view.getUint16(2, true),
    sampleRate: view.getUint32(4, true),
    byteRate: view.getUint32(8, true),
    blockAlign: view.getUint16(12, true),
    bitsPerSample: view.getUint16(14, true),
    cbSize: null,
    validBitsPerSample: null,
    channelMask: null,
    subFormatTag: null,
  };
  if (chunkSize >= 18 && view.byteLength >= 18)
    fmt.cbSize = view.getUint16(16, true);
  if (fmt.formatTag === 0xfffe) {
    if (chunkSize >= 40 && view.byteLength >= 40 && (fmt.cbSize ?? 0) >= 22) {
      fmt.validBitsPerSample = view.getUint16(18, true);
      fmt.channelMask = view.getUint32(20, true);
      fmt.subFormatTag = view.getUint16(24, true);
      let guidOk = true;
      for (let i = 0; i < KSDATA_GUID_TAIL.length; i++) {
        if (view.getUint8(26 + i) !== KSDATA_GUID_TAIL[i]) {
          guidOk = false;
          break;
        }
      }
      if (!guidOk) {
        add(
          "warn",
          "WARN_SUBFORMAT_GUID",
          "WAVE_FORMAT_EXTENSIBLE subformat GUID is non-standard; the encoding may be misidentified.",
        );
      }
    } else {
      add(
        "error",
        "ERR_EXT_SHORT",
        "fmt says WAVE_FORMAT_EXTENSIBLE but the chunk is too short to hold the subformat — actual encoding is unknown.",
      );
    }
  }
  return fmt;
}

// Parses any Blob (a browser File or a Node Blob) and cross-checks the header against the bytes actually present.
export async function parseWav(blob) {
  const issues = [];
  const add = (level, code, message) => issues.push({ level, code, message });
  const out = {
    fileSize: blob.size,
    container: null,
    chunks: [],
    fmt: null,
    info: null,
    bext: null,
    issues,
    summary: null,
  };

  if (blob.size < 12) {
    add(
      "error",
      "ERR_TOO_SMALL",
      `File is only ${blob.size} bytes — too small to be a WAV file.`,
    );
    return out;
  }

  const head = await readAt(blob, 0, 12);
  const riffId = fourcc(head, 0);
  const riffSize = head.getUint32(4, true);
  if (riffId === "RIFF") out.container = "RIFF";
  else if (riffId === "RF64" || riffId === "BW64") out.container = riffId;
  else if (riffId === "RIFX") {
    add(
      "error",
      "ERR_RIFX",
      "File is big-endian RIFX, which this tool (and most players) do not support.",
    );
    return out;
  } else {
    add(
      "error",
      "ERR_NOT_RIFF",
      `File does not start with "RIFF" (found "${riffId.replace(/[^\x20-\x7e]/g, ".")}") — not a WAV file.`,
    );
    return out;
  }
  if (fourcc(head, 8) !== "WAVE") {
    add(
      "error",
      "ERR_NOT_WAVE",
      `RIFF form type is "${fourcc(head, 8)}", not "WAVE" — this is a RIFF file but not a WAV.`,
    );
    return out;
  }

  const isRf64 = out.container !== "RIFF";
  let ds64 = null;
  let dataChunk = null;
  let factFrames = null;
  let streamedDataSize = false;
  let offset = 12;
  let lastEnd = 12;
  let lastPad = 0;
  let stopped = false;

  while (offset + 8 <= blob.size) {
    if (out.chunks.length >= MAX_CHUNKS) {
      add(
        "warn",
        "WARN_TOO_MANY_CHUNKS",
        `More than ${MAX_CHUNKS} chunks — stopping the walk early.`,
      );
      stopped = true;
      break;
    }
    const hdr = await readAt(blob, offset, 8);
    const id = fourcc(hdr, 0);
    if (!isChunkId(id)) {
      add(
        "error",
        "ERR_BAD_CHUNK",
        `Invalid chunk id at byte ${offset.toLocaleString()} — the file is likely corrupt from this point on.`,
      );
      stopped = true;
      break;
    }
    let size = hdr.getUint32(4, true);
    const bodyOffset = offset + 8;

    if (id === "ds64" && isRf64) {
      const v = await readAt(blob, bodyOffset, Math.min(size, 28));
      if (v.byteLength >= 28) {
        ds64 = {
          riffSize: Number(v.getBigUint64(0, true)),
          dataSize: Number(v.getBigUint64(8, true)),
          sampleCount: Number(v.getBigUint64(16, true)),
        };
      } else {
        add(
          "error",
          "ERR_DS64_SHORT",
          "RF64 ds64 chunk is too short — 64-bit sizes are unavailable.",
        );
      }
    }

    if (id === "data" && size === 0xffffffff && !dataChunk) {
      if (isRf64 && ds64) {
        size = ds64.dataSize;
      } else {
        streamedDataSize = true;
        size = Math.max(0, blob.size - bodyOffset);
        add(
          "warn",
          "WARN_STREAMED_SIZE",
          "data chunk size is the 0xFFFFFFFF placeholder (writer never finalized the header) — using the remaining file length instead.",
        );
      }
    }

    const available = Math.max(0, Math.min(size, blob.size - bodyOffset));
    const chunk = {
      id,
      offset: bodyOffset,
      size,
      available,
      truncated: available < size,
    };
    out.chunks.push(chunk);

    if (id === "fmt " && !out.fmt) {
      const v = await readAt(blob, bodyOffset, Math.min(size, 64));
      out.fmt = parseFmt(v, size, add);
    } else if (id === "data") {
      if (dataChunk) {
        add(
          "warn",
          "WARN_MULTIPLE_DATA",
          "File contains more than one data chunk — only the first is used.",
        );
      } else {
        dataChunk = chunk;
      }
    } else if (id === "fact") {
      const v = await readAt(blob, bodyOffset, Math.min(size, 4));
      if (v.byteLength >= 4) factFrames = v.getUint32(0, true);
    } else if (id === "LIST" && size >= 4 && size <= 256 * 1024) {
      const v = await readAt(blob, bodyOffset, available);
      if (v.byteLength >= 4 && fourcc(v, 0) === "INFO") {
        const tags = {};
        let p = 4;
        while (p + 8 <= v.byteLength) {
          const tid = fourcc(v, p);
          const tsize = v.getUint32(p + 4, true);
          if (!isChunkId(tid) || p + 8 + tsize > v.byteLength + 1) break;
          const text = asciiz(v, p + 8, Math.min(tsize, v.byteLength - p - 8));
          if (text) tags[INFO_TAGS[tid] || tid.trim()] = text;
          p += 8 + tsize + (tsize & 1);
        }
        if (Object.keys(tags).length) out.info = tags;
      }
    } else if (id === "bext" && size >= 338) {
      const v = await readAt(blob, bodyOffset, Math.min(available, 338));
      if (v.byteLength >= 338) {
        out.bext = {
          description: asciiz(v, 0, 256),
          originator: asciiz(v, 256, 32),
          date: asciiz(v, 320, 10),
          time: asciiz(v, 330, 8),
        };
      }
    }

    if (chunk.truncated) {
      if (id !== "data") {
        add(
          "warn",
          "WARN_CHUNK_TRUNCATED",
          `${id.trim()} chunk declares ${size.toLocaleString()} bytes but only ${available.toLocaleString()} are present.`,
        );
      }
      lastEnd = blob.size;
      break;
    }

    lastEnd = bodyOffset + size;
    lastPad = size & 1;
    offset = lastEnd + lastPad;
    if (offset === blob.size + 1) {
      // Final odd-sized chunk with the pad byte omitted — common and harmless.
      lastEnd = blob.size;
      lastPad = 0;
      break;
    }
  }

  // Bytes past the final chunk (and its pad byte, if odd-sized) belong to no chunk at all.
  if (!stopped) {
    const stray = blob.size - Math.min(blob.size, lastEnd + lastPad);
    if (stray > 0) {
      add(
        "info",
        "INFO_TRAILING",
        `${stray.toLocaleString()} stray byte(s) after the final chunk (too short to be another chunk).`,
      );
    }
  }

  // RIFF size field vs real file size.
  const declaredTotal =
    isRf64 && ds64
      ? ds64.riffSize + 8
      : riffSize === 0xffffffff
        ? null
        : riffSize + 8;
  if (declaredTotal != null && declaredTotal !== blob.size) {
    const diff = blob.size - declaredTotal;
    if (Math.abs(diff) === 1) {
      add(
        "info",
        "INFO_RIFF_SIZE_OFF1",
        "RIFF size field is off by exactly one byte — a final pad byte the writer did not count. Common and harmless, but noted.",
      );
    } else {
      add(
        "warn",
        "WARN_RIFF_SIZE",
        diff > 0
          ? `RIFF header declares a ${declaredTotal.toLocaleString()}-byte file but the file is ${blob.size.toLocaleString()} bytes — ${diff.toLocaleString()} extra bytes beyond the declared size.`
          : `RIFF header declares a ${declaredTotal.toLocaleString()}-byte file but only ${blob.size.toLocaleString()} bytes exist — the file is ${(-diff).toLocaleString()} bytes short of its own header.`,
      );
    }
  }

  // RF64: a fact chunk may hold the 0xFFFFFFFF placeholder, with the real frame count in ds64's sampleCount.
  if (factFrames === 0xffffffff && isRf64 && ds64)
    factFrames = ds64.sampleCount;

  const fmt = out.fmt;
  if (!fmt) {
    if (!issues.some((i) => i.code === "ERR_FMT_SHORT")) {
      add(
        "error",
        "ERR_NO_FMT",
        "No fmt chunk found — the file does not describe its own audio format.",
      );
    }
    return out;
  }
  if (!dataChunk)
    add(
      "error",
      "ERR_NO_DATA",
      "No data chunk found — the file contains no audio.",
    );

  const effectiveFormat =
    fmt.formatTag === 0xfffe ? fmt.subFormatTag : fmt.formatTag;
  const isLinear =
    effectiveFormat === 1 ||
    effectiveFormat === 3 ||
    effectiveFormat === 6 ||
    effectiveFormat === 7;

  if (fmt.channels === 0)
    add("error", "ERR_NO_CHANNELS", "fmt declares 0 channels.");
  if (fmt.sampleRate === 0)
    add("error", "ERR_NO_RATE", "fmt declares a sample rate of 0 Hz.");
  else if (fmt.sampleRate < 1000 || fmt.sampleRate > 768000) {
    add(
      "warn",
      "WARN_ODD_RATE",
      `Sample rate ${fmt.sampleRate.toLocaleString()} Hz is outside the usual range — possibly a corrupt header.`,
    );
  }

  let bytesPerSample = null;
  if (effectiveFormat === 1) {
    if (fmt.bitsPerSample === 0) {
      add(
        "error",
        "ERR_ZERO_BITS",
        "fmt declares 0 bits per sample — the audio cannot be interpreted.",
      );
    } else if (![8, 16, 24, 32].includes(fmt.bitsPerSample)) {
      add(
        "warn",
        "WARN_ODD_BITS",
        `${fmt.bitsPerSample}-bit integer PCM is unusual (expected 8, 16, 24, or 32).`,
      );
    }
    if (fmt.bitsPerSample > 0)
      bytesPerSample = Math.ceil(fmt.bitsPerSample / 8);
  } else if (effectiveFormat === 3) {
    if (![32, 64].includes(fmt.bitsPerSample)) {
      add(
        "warn",
        "WARN_ODD_BITS",
        `${fmt.bitsPerSample}-bit float is unusual (expected 32 or 64).`,
      );
    }
    if (fmt.bitsPerSample > 0)
      bytesPerSample = Math.ceil(fmt.bitsPerSample / 8);
  } else if (effectiveFormat === 6 || effectiveFormat === 7) {
    if (fmt.bitsPerSample !== 8) {
      add(
        "warn",
        "WARN_ODD_BITS",
        `G.711 audio should be 8-bit but fmt declares ${fmt.bitsPerSample}-bit.`,
      );
    }
    bytesPerSample = 1;
  }

  if (
    fmt.validBitsPerSample != null &&
    fmt.validBitsPerSample > fmt.bitsPerSample
  ) {
    add(
      "warn",
      "WARN_VALID_BITS",
      `fmt declares ${fmt.validBitsPerSample} valid bits inside ${fmt.bitsPerSample}-bit containers — impossible.`,
    );
  }

  if (isLinear && fmt.channels > 0 && bytesPerSample) {
    const expectedAlign = fmt.channels * bytesPerSample;
    if (fmt.blockAlign !== expectedAlign) {
      add(
        "warn",
        "WARN_BLOCK_ALIGN",
        `blockAlign is ${fmt.blockAlign} but ${fmt.channels} channel(s) × ${bytesPerSample} byte(s) = ${expectedAlign} — the header disagrees with itself.`,
      );
    }
    const expectedRate = fmt.sampleRate * expectedAlign;
    if (fmt.byteRate !== expectedRate) {
      add(
        "warn",
        "WARN_BYTE_RATE",
        `byteRate is ${fmt.byteRate.toLocaleString()} but ${fmt.sampleRate.toLocaleString()} Hz × ${expectedAlign} bytes/frame = ${expectedRate.toLocaleString()} — the header disagrees with itself.`,
      );
    }
  }
  if (!isLinear && dataChunk && factFrames == null && effectiveFormat != null) {
    add(
      "info",
      "INFO_NO_FACT",
      `Compressed format (${formatName(effectiveFormat)}) without a fact chunk — the duration cannot be determined from the header and is not shown.`,
    );
  }

  // Derived values are withheld, not guessed, when byteRate/blockAlign/channels/bit depth contradict each other — nothing can know which field is lying.
  let headerConsistent = null;
  if (isLinear && bytesPerSample && fmt.channels > 0 && fmt.sampleRate > 0) {
    const align = fmt.channels * bytesPerSample;
    headerConsistent =
      fmt.blockAlign === align && fmt.byteRate === fmt.sampleRate * align;
  }
  const frameBytes =
    headerConsistent === true ? fmt.channels * bytesPerSample : null;
  let headerFrames = null;
  let actualFrames = null;
  let headerDuration = null;
  let actualDuration = null;

  if (dataChunk) {
    if (dataChunk.truncated) {
      const missing = dataChunk.size - dataChunk.available;
      let missingTime = "";
      if (headerConsistent === true)
        missingTime = ` (about ${(missing / fmt.byteRate).toFixed(2)} s of audio)`;
      add(
        "error",
        "ERR_DATA_TRUNCATED",
        `data chunk declares ${dataChunk.size.toLocaleString()} bytes but only ${dataChunk.available.toLocaleString()} are present — the file is truncated, missing ${missing.toLocaleString()} bytes${missingTime}.`,
      );
    }
    if (frameBytes && dataChunk.size % frameBytes !== 0 && !streamedDataSize) {
      add(
        "warn",
        "WARN_DATA_ALIGN",
        `data size (${dataChunk.size.toLocaleString()} bytes) is not a whole number of ${frameBytes}-byte frames — the last frame is incomplete.`,
      );
    }
    if (frameBytes) {
      headerFrames = Math.floor(dataChunk.size / frameBytes);
      actualFrames = Math.floor(dataChunk.available / frameBytes);
      headerDuration = headerFrames / fmt.sampleRate;
      actualDuration = actualFrames / fmt.sampleRate;
    } else if (!isLinear && factFrames != null && fmt.sampleRate > 0) {
      headerFrames = factFrames;
      headerDuration = factFrames / fmt.sampleRate;
    }
    if (
      factFrames != null &&
      frameBytes &&
      headerFrames != null &&
      factFrames !== headerFrames
    ) {
      add(
        "warn",
        "WARN_FACT_MISMATCH",
        `fact chunk claims ${factFrames.toLocaleString()} frames but the data chunk holds ${headerFrames.toLocaleString()} — the header disagrees with itself.`,
      );
    }
  }

  out.summary = {
    formatTag: fmt.formatTag,
    effectiveFormat,
    formatName: formatName(effectiveFormat),
    viaExtensible: fmt.formatTag === 0xfffe,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    validBitsPerSample: fmt.validBitsPerSample,
    channelMask: fmt.channelMask,
    byteRate: fmt.byteRate,
    blockAlign: fmt.blockAlign,
    bytesPerSample,
    frameBytes,
    isLinear,
    headerConsistent,
    streamedSize: streamedDataSize,
    dataOffset: dataChunk ? dataChunk.offset : null,
    dataSize: dataChunk ? dataChunk.size : null,
    availableDataBytes: dataChunk ? dataChunk.available : null,
    headerFrames,
    actualFrames,
    headerDuration,
    actualDuration,
    factFrames,
    truncated: dataChunk ? dataChunk.truncated : false,
  };
  return out;
}

// Returns null for formats that cannot be decoded sample-by-sample here.
export function pcmCodec(summary) {
  if (!summary) return null;
  const f = summary.effectiveFormat;
  const bits = summary.bitsPerSample;
  if (f === 1) {
    if (bits === 8) return { kind: "u8", bytesPerSample: 1 };
    if (bits === 16) return { kind: "s16", bytesPerSample: 2 };
    if (bits === 24) return { kind: "s24", bytesPerSample: 3 };
    if (bits === 32) return { kind: "s32", bytesPerSample: 4 };
    return null;
  }
  if (f === 3) {
    if (bits === 32) return { kind: "f32", bytesPerSample: 4 };
    if (bits === 64) return { kind: "f64", bytesPerSample: 8 };
    return null;
  }
  if (f === 6) return { kind: "alaw", bytesPerSample: 1 };
  if (f === 7) return { kind: "mulaw", bytesPerSample: 1 };
  return null;
}
