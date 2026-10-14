import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWav, pcmCodec } from "../src/wav-parser.js";
import { buildWav, buildRf64, listInfoBody, blob } from "./fixtures.mjs";

const codes = (p) => p.issues.map((i) => i.code);
const has = (p, c) => codes(p).includes(c);
const levelsAtMost = (p, lv) => {
  const rank = { info: 0, warn: 1, error: 2 };
  return p.issues.every((i) => rank[i.level] <= rank[lv]);
};

test("clean PCM16 stereo 44.1 kHz file parses with zero issues", async () => {
  const p = await parseWav(
    blob(
      buildWav({
        fmt: { channels: 2, sampleRate: 44100, bitsPerSample: 16 },
        frames: 441,
      }),
    ),
  );
  assert.equal(p.issues.length, 0, JSON.stringify(p.issues));
  const s = p.summary;
  assert.equal(p.container, "RIFF");
  assert.equal(s.formatName, "PCM (integer)");
  assert.equal(s.channels, 2);
  assert.equal(s.sampleRate, 44100);
  assert.equal(s.bitsPerSample, 16);
  assert.equal(s.blockAlign, 4);
  assert.equal(s.byteRate, 176400);
  assert.equal(s.headerFrames, 441);
  assert.equal(s.actualFrames, 441);
  assert.ok(Math.abs(s.headerDuration - 0.01) < 1e-9);
  assert.equal(s.truncated, false);
  assert.deepEqual(pcmCodec(s), { kind: "s16", bytesPerSample: 2 });
});

test("32-bit float mono", async () => {
  const p = await parseWav(
    blob(
      buildWav({
        fmt: { formatTag: 3, bitsPerSample: 32, sampleRate: 48000, cbSize: 0 },
        frames: 480,
        fact: 480,
      }),
    ),
  );
  assert.equal(p.issues.length, 0, JSON.stringify(p.issues));
  assert.equal(p.summary.formatName, "IEEE float");
  assert.equal(p.summary.headerFrames, 480);
  assert.deepEqual(pcmCodec(p.summary), { kind: "f32", bytesPerSample: 4 });
});

test("24-bit and 8-bit PCM resolve the right codecs", async () => {
  const p24 = await parseWav(
    blob(buildWav({ fmt: { bitsPerSample: 24 }, frames: 10 })),
  );
  assert.deepEqual(pcmCodec(p24.summary), { kind: "s24", bytesPerSample: 3 });
  const p8 = await parseWav(
    blob(buildWav({ fmt: { bitsPerSample: 8 }, frames: 10 })),
  );
  assert.deepEqual(pcmCodec(p8.summary), { kind: "u8", bytesPerSample: 1 });
  assert.equal(p8.issues.length, 0, JSON.stringify(p8.issues));
});

test("WAVE_FORMAT_EXTENSIBLE resolves subformat and valid bits", async () => {
  const p = await parseWav(
    blob(
      buildWav({
        fmt: {
          formatTag: 0xfffe,
          bitsPerSample: 24,
          validBits: 20,
          subFormatTag: 1,
          channels: 2,
          channelMask: 3,
        },
        frames: 16,
      }),
    ),
  );
  assert.equal(p.issues.length, 0, JSON.stringify(p.issues));
  assert.equal(p.summary.effectiveFormat, 1);
  assert.equal(p.summary.viaExtensible, true);
  assert.equal(p.summary.validBitsPerSample, 20);
  assert.deepEqual(pcmCodec(p.summary), { kind: "s24", bytesPerSample: 3 });
});

test("µ-law with matching fact chunk", async () => {
  const p = await parseWav(
    blob(
      buildWav({
        fmt: { formatTag: 7, bitsPerSample: 8, cbSize: 0 },
        frames: 100,
        fact: 100,
      }),
    ),
  );
  assert.equal(p.issues.length, 0, JSON.stringify(p.issues));
  assert.equal(p.summary.formatName, "µ-law");
  assert.equal(p.summary.headerFrames, 100);
  assert.equal(pcmCodec(p.summary).kind, "mulaw");
});

test("fact chunk disagreeing with data size is flagged", async () => {
  const p = await parseWav(blob(buildWav({ frames: 50, fact: 60 })));
  assert.ok(has(p, "WARN_FACT_MISMATCH"), codes(p).join());
});

test("truncated data chunk: error plus corrected playable duration", async () => {
  const p = await parseWav(
    blob(
      buildWav({
        fmt: { sampleRate: 1000 },
        frames: 100,
        truncate: 40, // 20 frames missing
      }),
    ),
  );
  assert.ok(has(p, "ERR_DATA_TRUNCATED"), codes(p).join());
  assert.ok(has(p, "WARN_RIFF_SIZE"));
  assert.equal(p.summary.truncated, true);
  assert.equal(p.summary.headerFrames, 100);
  assert.equal(p.summary.actualFrames, 80);
  assert.ok(Math.abs(p.summary.actualDuration - 0.08) < 1e-9);
});

test("wrong byteRate: flagged, and derived values are withheld — not guessed", async () => {
  const p = await parseWav(blob(buildWav({ fmt: { byteRate: 15999 } })));
  assert.ok(has(p, "WARN_BYTE_RATE"), codes(p).join());
  assert.equal(p.summary.headerConsistent, false);
  assert.equal(p.summary.headerFrames, null);
  assert.equal(p.summary.headerDuration, null);
  assert.equal(p.summary.frameBytes, null);
});

test("wrong blockAlign: flagged, and derived values are withheld — not guessed", async () => {
  const p = await parseWav(
    blob(buildWav({ fmt: { blockAlign: 3, byteRate: 16000 }, frames: 10 })),
  );
  assert.ok(has(p, "WARN_BLOCK_ALIGN"), codes(p).join());
  assert.equal(p.summary.headerConsistent, false);
  assert.equal(p.summary.headerFrames, null);
  assert.equal(p.summary.headerDuration, null);
  assert.equal(p.summary.frameBytes, null);
});

test("wrong RIFF size is flagged with direction", async () => {
  const p = await parseWav(blob(buildWav({ riffSizeOverride: 20 })));
  assert.ok(has(p, "WARN_RIFF_SIZE"), codes(p).join());
});

test("RIFF size off by exactly one byte is an info note, not silence", async () => {
  const raw = buildWav({ frames: 4 });
  raw.writeUInt32LE(raw.readUInt32LE(4) + 1, 4);
  const p = await parseWav(blob(raw));
  assert.ok(has(p, "INFO_RIFF_SIZE_OFF1"), codes(p).join());
  assert.ok(!has(p, "WARN_RIFF_SIZE"));
  assert.equal(p.summary.headerFrames, 4); // header itself is consistent
});

test("short trailing garbage → info; garbage chunk header → corrupt error", async () => {
  const p1 = await parseWav(
    blob(buildWav({ trailing: Buffer.from([1, 2, 3, 4, 5]) })),
  );
  assert.ok(has(p1, "INFO_TRAILING"), codes(p1).join());
  const p2 = await parseWav(
    blob(buildWav({ trailing: Buffer.alloc(16, 0xff) })),
  );
  assert.ok(has(p2, "ERR_BAD_CHUNK"), codes(p2).join());
});

test("odd-sized chunk before data is padded and walked correctly", async () => {
  const p = await parseWav(
    blob(
      buildWav({
        preChunks: [{ id: "JUNK", body: Buffer.alloc(27) }],
        frames: 4,
      }),
    ),
  );
  assert.equal(p.issues.length, 0, JSON.stringify(p.issues));
  assert.deepEqual(
    p.chunks.map((c) => c.id),
    ["JUNK", "fmt ", "data"],
  );
  assert.equal(p.summary.headerFrames, 4);
});

test("odd-sized final data chunk with pad omitted is clean", async () => {
  const raw = buildWav({ fmt: { bitsPerSample: 8 }, frames: 7 });
  // buildWav pads the final chunk; drop the pad byte to simulate lazy writers.
  const unpadded = Buffer.concat([raw.subarray(0, raw.length - 1)]);
  unpadded.writeUInt32LE(unpadded.length - 8, 4);
  const p = await parseWav(blob(unpadded));
  assert.equal(p.issues.length, 0, JSON.stringify(p.issues));
  assert.equal(p.summary.headerFrames, 7);
});

test("data size not a whole number of frames is flagged", async () => {
  const p = await parseWav(
    blob(
      buildWav({
        fmt: { channels: 2, bitsPerSample: 16 },
        data: Buffer.alloc(10), // 2.5 frames
      }),
    ),
  );
  assert.ok(has(p, "WARN_DATA_ALIGN"), codes(p).join());
});

test("multiple data chunks: warn, first one wins", async () => {
  const p = await parseWav(
    blob(
      buildWav({
        frames: 4,
        postChunks: [{ id: "data", body: Buffer.alloc(100) }],
      }),
    ),
  );
  assert.ok(has(p, "WARN_MULTIPLE_DATA"), codes(p).join());
  assert.equal(p.summary.headerFrames, 4);
});

test("0xFFFFFFFF streaming placeholder size falls back to measured remaining bytes", async () => {
  const p = await parseWav(
    blob(buildWav({ frames: 12, dataSizeOverride: 0xffffffff })),
  );
  assert.ok(has(p, "WARN_STREAMED_SIZE"), codes(p).join());
  assert.equal(p.summary.headerFrames, 12);
  assert.equal(p.summary.streamedSize, true);
  assert.ok(levelsAtMost(p, "warn"));
});

test("RF64 sizes come from ds64 with no size warnings", async () => {
  const p = await parseWav(blob(buildRf64({ frames: 32 })));
  assert.equal(p.container, "RF64");
  assert.equal(p.issues.length, 0, JSON.stringify(p.issues));
  assert.equal(p.summary.dataSize, 64);
  assert.equal(p.summary.headerFrames, 32);
});

test("RF64 fact placeholder resolves through ds64 sampleCount — no false mismatch", async () => {
  const p = await parseWav(
    blob(buildRf64({ frames: 32, factPlaceholder: true })),
  );
  assert.equal(p.issues.length, 0, JSON.stringify(p.issues));
  assert.equal(p.summary.factFrames, 32);
  assert.equal(p.summary.headerFrames, 32);
});

test("second data chunk with a placeholder size does not corrupt the first", async () => {
  const p = await parseWav(
    blob(
      buildWav({
        frames: 4,
        postChunks: [
          { id: "data", body: Buffer.alloc(8), sizeOverride: 0xffffffff },
        ],
      }),
    ),
  );
  assert.ok(has(p, "WARN_MULTIPLE_DATA"), codes(p).join());
  assert.ok(!has(p, "WARN_STREAMED_SIZE"));
  assert.equal(p.summary.streamedSize, false);
  assert.equal(p.summary.headerFrames, 4);
});

test("LIST INFO tags are extracted", async () => {
  const p = await parseWav(
    blob(
      buildWav({
        postChunks: [
          {
            id: "LIST",
            body: listInfoBody({ INAM: "Sine test", IART: "A Recordist" }),
          },
        ],
      }),
    ),
  );
  assert.equal(p.info.Title, "Sine test");
  assert.equal(p.info.Artist, "A Recordist");
});

test("LIST INFO text decodes Latin-1 when it is not valid UTF-8", async () => {
  // 200 KB: more bytes than a single spread call can take, so a regression throws RangeError.
  const text = "Café".repeat(50_000);
  const p = await parseWav(
    blob(
      buildWav({
        postChunks: [
          {
            id: "LIST",
            body: listInfoBody({ IART: text }, "latin1"),
          },
        ],
      }),
    ),
  );
  assert.equal(p.info.Artist, text);
});

test("LIST INFO text decodes UTF-8 when the bytes are well-formed UTF-8", async () => {
  const p = await parseWav(
    blob(
      buildWav({
        postChunks: [
          {
            id: "LIST",
            body: listInfoBody({ IART: "Café" }, "utf8"),
          },
        ],
      }),
    ),
  );
  assert.equal(p.info.Artist, "Café");
});

test("structural failures: tiny, not-RIFF, not-WAVE, no fmt, no data, zero fields", async () => {
  assert.ok(has(await parseWav(blob(Buffer.alloc(4))), "ERR_TOO_SMALL"));
  assert.ok(
    has(
      await parseWav(blob(Buffer.from("OggS" + "\0".repeat(40)))),
      "ERR_NOT_RIFF",
    ),
  );
  const avi = buildWav({});
  avi.write("AVI ", 8, "latin1");
  assert.ok(has(await parseWav(blob(avi)), "ERR_NOT_WAVE"));
  assert.ok(has(await parseWav(blob(buildWav({ noFmt: true }))), "ERR_NO_FMT"));
  assert.ok(
    has(await parseWav(blob(buildWav({ noData: true }))), "ERR_NO_DATA"),
  );
  assert.ok(
    has(
      await parseWav(blob(buildWav({ fmt: { channels: 0 } }))),
      "ERR_NO_CHANNELS",
    ),
  );
  assert.ok(
    has(
      await parseWav(blob(buildWav({ fmt: { sampleRate: 0 } }))),
      "ERR_NO_RATE",
    ),
  );
  assert.ok(
    has(
      await parseWav(blob(buildWav({ fmt: { bitsPerSample: 0 } }))),
      "ERR_ZERO_BITS",
    ),
  );
});

test("single stray byte after an even-sized final chunk is reported", async () => {
  const p = await parseWav(
    blob(buildWav({ frames: 4, trailing: Buffer.from([0x42]) })),
  );
  assert.ok(has(p, "INFO_TRAILING"), codes(p).join());
});

test("unusual sample rate is flagged", async () => {
  const p = await parseWav(blob(buildWav({ fmt: { sampleRate: 500 } })));
  assert.ok(has(p, "WARN_ODD_RATE"), codes(p).join());
});

test("compressed format without fact: duration withheld, never estimated", async () => {
  const p = await parseWav(
    blob(
      buildWav({
        fmt: {
          formatTag: 2,
          bitsPerSample: 4,
          blockAlign: 256,
          byteRate: 4000,
          cbSize: 2,
        },
        data: Buffer.alloc(1024),
      }),
    ),
  );
  assert.equal(pcmCodec(p.summary), null);
  assert.equal(p.summary.isLinear, false);
  assert.equal(p.summary.headerDuration, null);
  assert.ok(has(p, "INFO_NO_FACT"), codes(p).join());
});

test("compressed format with fact: duration comes from the declared frame count", async () => {
  const p = await parseWav(
    blob(
      buildWav({
        fmt: {
          formatTag: 2,
          bitsPerSample: 4,
          blockAlign: 256,
          byteRate: 4000,
          cbSize: 2,
          sampleRate: 8000,
        },
        data: Buffer.alloc(1024),
        fact: 2000,
      }),
    ),
  );
  assert.equal(p.summary.headerFrames, 2000);
  assert.ok(Math.abs(p.summary.headerDuration - 0.25) < 1e-9);
});
