import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWaveform } from "../src/waveform.js";

// A minimal stand-in for a Web Audio AudioBuffer — computeWaveform only touches these three members, so no real browser is needed.
function fakeBuffer(channelArrays) {
  return {
    numberOfChannels: channelArrays.length,
    length: channelArrays.length ? channelArrays[0].length : 0,
    getChannelData: (c) => channelArrays[c],
  };
}

test("mono sine: RMS sits 3.01 dB below peak, no clipping", async () => {
  const n = 8000;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++)
    data[i] = 0.5 * Math.sin((2 * Math.PI * 100 * i) / n);
  const r = await computeWaveform(fakeBuffer([data]));
  assert.ok(Math.abs(r.peakDb - 20 * Math.log10(0.5)) < 0.01);
  assert.ok(Math.abs(r.rmsDb - (20 * Math.log10(0.5) - 3.0103)) < 0.05);
  assert.equal(r.fullScaleCount, 0);
  assert.equal(r.frames, n);
  assert.equal(r.channels, 1);
});

test("full-scale samples are counted as clipped", async () => {
  const data = new Float32Array(64).fill(1);
  const r = await computeWaveform(fakeBuffer([data]));
  assert.equal(r.fullScaleCount, 64);
  assert.ok(r.peakDb > -0.001);
});

test("stereo constants land in the right min/max buckets", async () => {
  const n = 128;
  const l = new Float32Array(n).fill(0.5);
  const rch = new Float32Array(n).fill(-0.5);
  const r = await computeWaveform(fakeBuffer([l, rch]));
  assert.ok(Math.abs(r.maxs[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(r.mins[0] + 0.5) < 1e-6);
  assert.ok(Math.abs(r.rmsDb - 20 * Math.log10(0.5)) < 0.01);
});

test("digital silence: -Infinity levels, zeroed waveform", async () => {
  const r = await computeWaveform(fakeBuffer([new Float32Array(100)]));
  assert.equal(r.peakDb, -Infinity);
  assert.equal(r.rmsDb, -Infinity);
  assert.equal(r.fullScaleCount, 0);
  assert.ok([...r.mins].every((v) => v === 0));
});

test("waveform buckets are fully populated and finite", async () => {
  const n = 2400;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++)
    data[i] = 0.3 * Math.sin((2 * Math.PI * 50 * i) / n);
  const r = await computeWaveform(fakeBuffer([data]), { columns: 1200 });
  assert.equal(r.mins.length, 1200);
  assert.ok([...r.mins].every(Number.isFinite));
  assert.ok([...r.maxs].every(Number.isFinite));
});

test("cancellation aborts and resolves null", async () => {
  const data = new Float32Array(1_500_000); // large enough to cross a yield point
  const r = await computeWaveform(fakeBuffer([data]), {
    isCancelled: () => true,
  });
  assert.equal(r, null);
});

test("empty buffer (no channels or no frames) resolves null", async () => {
  assert.equal(await computeWaveform(fakeBuffer([])), null);
  assert.equal(await computeWaveform(fakeBuffer([new Float32Array(0)])), null);
});
