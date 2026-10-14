// Waveform and level stats over an already-decoded buffer — no format-specific code here, nothing to license.

// Takes anything duck-typing AudioBuffer (so the suite can exercise it without a browser) — do not narrow this to a real AudioBuffer.

const YIELD_EVERY_FRAMES = 500_000;

export async function computeWaveform(
  audioBuffer,
  { columns = 1200, isCancelled } = {},
) {
  const channels = audioBuffer.numberOfChannels;
  const totalFrames = audioBuffer.length;
  if (!channels || !totalFrames) return null;

  const chData = [];
  for (let c = 0; c < channels; c++) chData.push(audioBuffer.getChannelData(c));

  const mins = new Float32Array(columns).fill(Infinity);
  const maxs = new Float32Array(columns).fill(-Infinity);
  let peak = 0;
  let sumSq = 0;
  let fullScaleCount = 0;

  for (let i = 0; i < totalFrames; i++) {
    const col = Math.min(columns - 1, Math.floor((i * columns) / totalFrames));
    for (let c = 0; c < channels; c++) {
      const x = chData[c][i];
      if (x < mins[col]) mins[col] = x;
      if (x > maxs[col]) maxs[col] = x;
      const a = Math.abs(x);
      if (a > peak) peak = a;
      sumSq += x * x;
      if (a >= 1) fullScaleCount++; // decoded samples are float; >=1 is full scale
    }
    if (i > 0 && i % YIELD_EVERY_FRAMES === 0) {
      if (isCancelled && isCancelled()) return null;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (isCancelled && isCancelled()) return null;

  for (let i = 0; i < columns; i++) {
    if (mins[i] === Infinity) {
      mins[i] = 0;
      maxs[i] = 0;
    }
  }
  const rms = Math.sqrt(sumSq / (totalFrames * channels));
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  return {
    columns,
    mins,
    maxs,
    frames: totalFrames,
    channels,
    peak,
    peakDb: db(peak),
    rmsDb: db(rms),
    fullScaleCount,
  };
}
