import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWav } from "../src/wav-parser.js";
import { scanAudio, mulawToInt, alawToInt } from "../src/wav-scan.js";
import { buildWav, pcm16, pcm16Sine, blob } from "./fixtures.mjs";

async function scanOf(buf, opts) {
  const b = blob(buf);
  const parsed = await parseWav(b);
  return { parsed, scan: await scanAudio(b, parsed, opts) };
}

test("sine wave: RMS sits 3.01 dB below peak, no full-scale hits", async () => {
  const { fmt, data } = pcm16Sine({
    frames: 8000,
    rate: 8000,
    freq: 100,
    amp: 30000,
  });
  const { scan } = await scanOf(buildWav({ fmt, data }));
  const expectedPeakDb = 20 * Math.log10(30000 / 32768);
  assert.ok(
    Math.abs(scan.peakDb - expectedPeakDb) < 0.01,
    `peak ${scan.peakDb}`,
  );
  assert.ok(
    Math.abs(scan.rmsDb - (expectedPeakDb - 3.0103)) < 0.05,
    `rms ${scan.rmsDb}`,
  );
  assert.equal(scan.fullScaleCount, 0);
  assert.equal(scan.frames, 8000);
});

test("full-scale square wave: every sample counted as clipped", async () => {
  const data = pcm16(new Array(64).fill(32767));
  const { scan } = await scanOf(buildWav({ data }));
  assert.equal(scan.fullScaleCount, 64);
  assert.ok(scan.peakDb > -0.001);
});

test("stereo constants land in min/max and RMS correctly", async () => {
  const frames = 128;
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(16384, i * 4); // L = +0.5
    buf.writeInt16LE(-16384, i * 4 + 2); // R = -0.5
  }
  const { scan } = await scanOf(buildWav({ fmt: { channels: 2 }, data: buf }));
  assert.ok(Math.abs(scan.maxs[0] - 0.5) < 1e-4);
  assert.ok(Math.abs(scan.mins[0] + 0.5) < 1e-4);
  assert.ok(Math.abs(scan.rmsDb - 20 * Math.log10(0.5)) < 0.01);
});

test("digital silence: -Infinity levels, zeroed waveform", async () => {
  const { scan } = await scanOf(buildWav({ frames: 100 }));
  assert.equal(scan.peakDb, -Infinity);
  assert.equal(scan.rmsDb, -Infinity);
  assert.equal(scan.fullScaleCount, 0);
  assert.ok([...scan.mins].every((v) => v === 0));
});

test("24-bit samples decode with correct scaling", async () => {
  const data = Buffer.from([0x00, 0x00, 0x40, 0x00, 0x00, 0xc0]); // +0.5, -0.5
  const { scan } = await scanOf(buildWav({ fmt: { bitsPerSample: 24 }, data }));
  assert.ok(Math.abs(scan.peak - 0.5) < 1e-6);
  assert.ok(Math.abs(scan.maxs[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(Math.min(...scan.mins) + 0.5) < 1e-6);
});

test("G.711 decoders match the reference values", () => {
  assert.equal(mulawToInt(0xff), 0);
  assert.equal(mulawToInt(0x7f), 0);
  assert.equal(mulawToInt(0x00), -32124);
  assert.equal(mulawToInt(0x80), 32124);
  assert.equal(alawToInt(0x55), -8);
  assert.equal(alawToInt(0xd5), 8);
  assert.equal(alawToInt(0x2a), -32256);
  assert.equal(alawToInt(0xaa), 32256);
});

test("truncated file scans only the frames actually present", async () => {
  const { parsed, scan } = await scanOf(
    buildWav({ frames: 100, truncate: 40 }),
  );
  assert.equal(parsed.summary.actualFrames, 80);
  assert.equal(scan.frames, 80);
});

test("waveform buckets are fully populated and finite", async () => {
  const { fmt, data } = pcm16Sine({ frames: 2400, rate: 8000, freq: 50 });
  const { scan } = await scanOf(buildWav({ fmt, data }), { columns: 1200 });
  assert.equal(scan.mins.length, 1200);
  assert.ok([...scan.mins].every(Number.isFinite));
  assert.ok([...scan.maxs].every(Number.isFinite));
});

test("progress is reported and cancellation aborts", async () => {
  const { fmt, data } = pcm16Sine({ frames: 8000 });
  const buf = buildWav({ fmt, data });
  let calls = 0;
  const { scan } = await scanOf(buf, { onProgress: () => calls++ });
  assert.ok(calls >= 1);
  assert.ok(scan);
  const { scan: cancelled } = await scanOf(buf, { isCancelled: () => true });
  assert.equal(cancelled, null);
});

test("scanner refuses files whose header is self-inconsistent", async () => {
  const { scan } = await scanOf(
    buildWav({ fmt: { blockAlign: 3 }, frames: 10 }),
  );
  assert.equal(scan, null);
});

test("non-linear formats are skipped by the scanner", async () => {
  const { scan } = await scanOf(
    buildWav({
      fmt: {
        formatTag: 2,
        bitsPerSample: 4,
        blockAlign: 256,
        byteRate: 4000,
        cbSize: 2,
      },
      data: Buffer.alloc(512),
    }),
  );
  assert.equal(scan, null);
});
