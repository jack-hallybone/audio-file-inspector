// The page, the transport, and the reporting of what the parser found.

// Imported first, before a control is built — the app's whole defence against being framed and driven by somebody else's clicks.
import "./no-frame.js";
import { parseWav, pcmCodec } from "./wav-parser.js";
import { scanAudio } from "./wav-scan.js";
import { computeWaveform } from "./waveform.js";

const $ = (id) => document.getElementById(id);

// Path data copied verbatim from Lucide 1.41.0 (https://lucide.dev), ISC — see THIRD-PARTY-NOTICES.md.
const ICONS = {
  "audio-lines":
    '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "file-audio":
    '<path d="M4 6.835V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-.343"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M2 19a2 2 0 0 1 4 0v1a2 2 0 0 1-4 0v-4a6 6 0 0 1 12 0v4a2 2 0 0 1-4 0v-1a2 2 0 0 1 4 0"/>',
  "folder-open":
    '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  "hard-drive-download":
    '<path d="M12 2v8"/><path d="m16 6-4 4-4-4"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 18h.01"/><path d="M10 18h.01"/>',
  play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
  pause:
    '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>',
  repeat:
    '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  "triangle-alert":
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  "circle-alert":
    '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
};
// Icon size is a markup fact (data-icon-size), not computed from the wrapper's own classes — style.css's .icon scales off --icon-*.
function icon(name, sizeModifier) {
  const cls = sizeModifier ? `icon ${sizeModifier}` : "icon";
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}
function fillIcon(el) {
  el.innerHTML = icon(el.dataset.icon, el.dataset.iconSize);
}
for (const el of document.querySelectorAll("[data-icon]")) fillIcon(el);

// Captured before load() starts rewriting the title with the open file's name.
const PRODUCT = document.title;
const audio = $("audio");
const els = {
  empty: $("empty"),
  player: $("player"),
  filename: $("filename"),
  waveWrap: $("wave-wrap"),
  wave: $("wave"),
  cursor: $("cursor"),
  waveMsg: $("wave-msg"),
  scanProgress: $("scan-progress"),
  play: $("play"),
  time: $("time"),
  seek: $("seek"),
  dur: $("dur"),
  loop: $("loop"),
  autoplay: $("autoplay"),
  summary: $("summary"),
  verdict: $("verdict"),
  issues: $("issues"),
  details: $("details"),
  meta: $("meta"),
  checks: $("checks"),
  deepVerify: $("deep-verify"),
  installBtn: $("install-btn"),
  openBtn: $("open-btn"),
  fileInput: $("file-input"),
  toast: $("toast"),
};

let file = null;
let parsed = null;
let scan = null;
let objectUrl = null;
let gen = 0; // load generation, cancels stale async work
let seekDragging = false;
let waveDragging = false;
let problems = {}; // keyed problem entries: { level, text }
let verified = {}; // keyed names of checks that passed
let pending = new Set(); // checks still outstanding — blocks a "Passed" verdict
let notApplicable = false; // non-WAV: there is no header to check
let deepDeferred = false; // full decode skipped (large file), offered via button
let measuredChannels = null; // non-WAV: channel count from the decoder

// ---------- preferences ----------
// localStorage can throw outright rather than return null, so both accesses are guarded.
function prefGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function prefSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preference is session-only */
  }
}

const PREF_AUTOPLAY = "audio-file-inspector:autoplay";
const PREF_VOLUME = "audio-file-inspector:volume";

let autoplay = prefGet(PREF_AUTOPLAY, "1") !== "0";

// ---------- formatting ----------
const nf = new Intl.NumberFormat("en-US");
function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let u = -1;
  do {
    n /= 1024;
    u++;
  } while (n >= 1024 && u < units.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[u]}`;
}
function fmtTime(s) {
  if (s == null || !isFinite(s)) return "—";
  const neg = s < 0 ? "-" : "";
  s = Math.abs(s);
  const m = Math.floor(s / 60);
  return `${neg}${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
}
function fmtDb(db) {
  if (db === -Infinity) return "−∞ dBFS";
  return `${db >= 0 ? "+" : "−"}${Math.abs(db).toFixed(2)} dBFS`;
}
function fileExt(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || "");
  return m ? `.${m[1].toLowerCase()}` : null;
}
function fileExtLabel(name) {
  const ext = fileExt(name);
  return ext ? `${ext} files` : "this file type";
}
// Every "we don't have this" message shares this suffix, so it is learned once.
function notAvailableFor(name) {
  return `not available for ${fileExtLabel(name)}`;
}
function errText(err, fallback) {
  return err && err.message ? err.message : fallback;
}
let toastTimer = 0;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1200);
}

// ---------- integrity verdict ----------
// `pending` is filled before any check resolves — registering one late is how a file can read Passed, then fail a second later.
const BADGES = { info: "info", warn: "triangle-alert", err: "circle-alert" };
const BADGE_TONE = { warn: "text-warning", err: "text-danger" };
function renderIntegrity() {
  const order = { err: 0, warn: 1, info: 2 };
  const all = Object.values(problems)
    .filter(Boolean)
    .sort((a, b) => order[a.level] - order[b.level]);
  // Disagreements fail the check; info-level entries are notes, not failures.
  const failures = all.filter((p) => p.level === "err" || p.level === "warn");

  els.issues.replaceChildren();
  for (const it of all) {
    const li = document.createElement("li");
    li.className = `row start text-md lv-${it.level}`;
    const badge = document.createElement("span");
    badge.className = `issue-icon ${BADGE_TONE[it.level] ?? ""}`.trim();
    // Decoration: the sentence beside it already says what happened, so icon() hides the glyph from AT.
    badge.innerHTML = icon(BADGES[it.level], "xs");
    const text = document.createElement("span");
    text.className = "issue-text";
    text.textContent = it.text;
    li.append(badge, text);
    els.issues.append(li);
  }

  // The full list stays auditable under "All header fields".
  const names = Object.values(verified).filter(Boolean);
  els.checks.textContent = names.length ? `Checks: ${names.join(", ")}.` : "";

  // The " · " separator is real text, not CSS content, so it survives copy-paste and reaches a screen reader.
  // `ok`/`fail` exist only for the e2e suite to select on; `text-success`/`text-danger` carry the colour — both classes must travel together.
  if (notApplicable) {
    els.verdict.textContent = ` · checks ${notAvailableFor(file.name)}`;
    els.verdict.className = "text-muted";
  } else if (failures.length) {
    els.verdict.textContent = " · ✕ Failed";
    els.verdict.className = "fail text-danger";
  } else if (pending.size) {
    els.verdict.textContent = " · checking…";
    els.verdict.className = "text-muted";
  } else if (Object.keys(verified).length) {
    els.verdict.textContent = deepDeferred
      ? " · ✓ Passed (full decode not run)"
      : " · ✓ Passed";
    els.verdict.className = "ok text-success";
  } else {
    els.verdict.textContent = "";
    els.verdict.className = "";
  }
}
function problem(key, level, text) {
  problems[key] = text == null ? null : { level, text };
  pending.delete(key);
  renderIntegrity();
}
function pass(key, name) {
  verified[key] = name;
  pending.delete(key);
  renderIntegrity();
}
function skip(key) {
  // check will not run; it neither passed nor failed
  pending.delete(key);
  renderIntegrity();
}

// ---------- format display ----------
function bitDepthText(s) {
  if (s.effectiveFormat === 3) return `${s.bitsPerSample}-bit float`;
  if (s.effectiveFormat === 6 || s.effectiveFormat === 7)
    return "8-bit companded";
  let t = `${s.bitsPerSample}-bit`;
  if (
    s.validBitsPerSample != null &&
    s.validBitsPerSample !== s.bitsPerSample
  ) {
    t += ` (${s.validBitsPerSample} valid)`;
  }
  return t;
}
function renderSummary() {
  const s = parsed && parsed.summary;
  const parts = [];
  if (s) {
    parts.push(
      `${s.channels} ch`,
      `${nf.format(s.sampleRate)} Hz`,
      bitDepthText(s),
      s.formatName,
    );
  } else if (measuredChannels != null) {
    // Non-WAV: channel count is known only once the decode has run.
    parts.push(`${measuredChannels} ch`);
  }
  parts.push(fmtBytes(parsed ? parsed.fileSize : file.size));
  els.summary.textContent = parts.join(" · ");
}
function metaRow(label, value, withheld = false) {
  const dt = document.createElement("dt");
  dt.className = "text-muted";
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  dd.className = withheld ? "withheld text-sans text-muted" : "text-mono";
  els.meta.append(dt, dd);
}
function renderMeta() {
  els.meta.replaceChildren();
  const s = parsed.summary;
  metaRow(
    "Container",
    parsed.container
      ? parsed.container === "RIFF"
        ? "RIFF (WAVE)"
        : `${parsed.container} (64-bit WAVE)`
      : notAvailableFor(file.name),
    !parsed.container,
  );
  if (!s) {
    metaRow(
      "File size",
      `${fmtBytes(parsed.fileSize)} (${nf.format(parsed.fileSize)} bytes)`,
    );
    return;
  }
  metaRow(
    "Encoding",
    s.formatName + (s.viaExtensible ? " · via Extensible" : ""),
  );
  metaRow("Sample rate", `${nf.format(s.sampleRate)} Hz`);
  metaRow("Channels", String(s.channels));
  metaRow("Bit depth", bitDepthText(s));
  if (s.headerDuration != null) {
    const label = s.truncated
      ? "Duration (declared)"
      : s.streamedSize
        ? "Duration (from bytes present)"
        : "Duration";
    let v = fmtTime(s.headerDuration);
    if (s.headerFrames != null) v += ` · ${nf.format(s.headerFrames)} frames`;
    metaRow(label, v);
    if (s.truncated && s.actualDuration != null) {
      metaRow(
        "Playable (measured)",
        `${fmtTime(s.actualDuration)} · ${nf.format(s.actualFrames)} frames`,
      );
    }
  } else if (s.isLinear && s.headerConsistent === false) {
    metaRow("Duration", "withheld — header fields contradict each other", true);
  } else {
    metaRow("Duration", "not declared (no fact chunk)", true);
  }
  if (s.byteRate) metaRow("Data rate (declared)", `${fmtBytes(s.byteRate)}/s`);
  metaRow(
    "Frame size (declared)",
    s.blockAlign ? `${s.blockAlign} bytes` : "—",
  );
  if (s.dataSize != null)
    metaRow(
      "Audio data",
      `${fmtBytes(s.dataSize)} at offset ${nf.format(s.dataOffset)}`,
    );
  metaRow(
    "File size",
    `${fmtBytes(parsed.fileSize)} (${nf.format(parsed.fileSize)} bytes)`,
  );
  const others = parsed.chunks
    .filter((c) => c.id !== "fmt " && c.id !== "data")
    .map((c) => c.id.trim())
    .join(", ");
  if (others) metaRow("Other chunks", others);
  if (parsed.info)
    for (const [k, v] of Object.entries(parsed.info)) metaRow(k, v);
  if (parsed.bext) {
    if (parsed.bext.description)
      metaRow("BWF description", parsed.bext.description);
    if (parsed.bext.originator)
      metaRow("BWF originator", parsed.bext.originator);
    if (parsed.bext.date)
      metaRow(
        "BWF recorded",
        `${parsed.bext.date} ${parsed.bext.time || ""}`.trim(),
      );
  }
}

// ---------- waveform ----------
function sizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  const w = els.wave.clientWidth,
    h = els.wave.clientHeight;
  for (const c of [els.wave, els.cursor]) {
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
  }
}
// Resolved off the element, never read as a custom property.
const painted = (el) => getComputedStyle(el).color;
function drawWave() {
  const ctx = els.wave.getContext("2d");
  ctx.clearRect(0, 0, els.wave.width, els.wave.height);
  if (!scan) return;
  ctx.fillStyle = painted(els.wave);
  const { columns, mins, maxs } = scan;
  const w = els.wave.width,
    h = els.wave.height,
    mid = h / 2,
    half = h / 2 - 2;
  const colW = Math.max(1, w / columns);
  for (let i = 0; i < columns; i++) {
    const top = mid - Math.min(1, Math.max(-1, maxs[i])) * half;
    const bot = mid - Math.min(1, Math.max(-1, mins[i])) * half;
    ctx.fillRect((i * w) / columns, top, colW, Math.max(1, bot - top));
  }
}
function drawCursor() {
  const ctx = els.cursor.getContext("2d");
  ctx.clearRect(0, 0, els.cursor.width, els.cursor.height);
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  ctx.fillStyle = painted(els.cursor);
  ctx.fillRect(
    (audio.currentTime / d) * els.cursor.width - 0.75,
    0,
    1.5,
    els.cursor.height,
  );
}
new ResizeObserver(() => {
  sizeCanvases();
  drawWave();
  drawCursor();
}).observe(els.waveWrap);
// A canvas keeps yesterday's pixels until something draws again, so a scheme/contrast change must repaint the waveform.
for (const query of [
  "(prefers-color-scheme: dark)",
  "(prefers-contrast: more)",
]) {
  matchMedia(query).addEventListener("change", drawWave);
}

// scanAudio and computeWaveform produce the same shape, so applying the result is identical either way.
function applyScanResult(result) {
  scan = result;
  drawWave();
  els.waveMsg.hidden = true;
  metaRow("Peak level (measured)", fmtDb(result.peakDb));
  metaRow("RMS level (measured)", fmtDb(result.rmsDb));
  if (result.fullScaleCount > 0) {
    metaRow("Full-scale samples", nf.format(result.fullScaleCount));
    problem(
      "clip",
      "info",
      `${nf.format(result.fullScaleCount)} sample(s) at digital full scale — the recording may be clipped.`,
    );
  }
}

// ---------- transport ----------
function updateTransport() {
  if (els.player.hidden) return;
  const d = audio.duration;
  els.time.textContent = fmtTime(audio.currentTime);
  if (!seekDragging && isFinite(d) && d > 0)
    els.seek.value = Math.round((audio.currentTime / d) * 10000);
  // This runs every animation frame, so the markup is rewritten only when it changes.
  const glyph = audio.paused ? "play" : "pause";
  if (els.play.dataset.icon !== glyph) {
    els.play.dataset.icon = glyph;
    fillIcon(els.play);
    els.play.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
  }
  drawCursor();
}
(function raf() {
  updateTransport();
  requestAnimationFrame(raf);
})();

function seekToFraction(f) {
  const d = audio.duration;
  if (isFinite(d) && d > 0)
    audio.currentTime = Math.min(d - 0.001, Math.max(0, f * d));
}
els.play.addEventListener("click", () => {
  audio.paused ? audio.play().catch(() => {}) : audio.pause();
});
els.seek.addEventListener("pointerdown", () => {
  seekDragging = true;
});
els.seek.addEventListener("pointerup", () => {
  seekDragging = false;
});
els.seek.addEventListener("pointercancel", () => {
  seekDragging = false;
});
els.seek.addEventListener("input", () =>
  seekToFraction(els.seek.value / 10000),
);
// aria-pressed carries the state for assistive tech; .selected is just the visual for it.
function setPressed(el, on) {
  el.setAttribute("aria-pressed", String(on));
  el.classList.toggle("selected", on);
}
els.loop.addEventListener("click", () => {
  audio.loop = !audio.loop;
  setPressed(els.loop, audio.loop);
});
setPressed(els.autoplay, autoplay);
els.autoplay.addEventListener("click", () => {
  autoplay = !autoplay;
  setPressed(els.autoplay, autoplay);
  prefSet(PREF_AUTOPLAY, autoplay ? "1" : "0");
  toast(autoplay ? "Autoplay on" : "Autoplay off");
});
function waveSeek(e) {
  const r = els.waveWrap.getBoundingClientRect();
  seekToFraction((e.clientX - r.left) / r.width);
}
els.waveWrap.addEventListener("pointerdown", (e) => {
  waveDragging = true;
  els.waveWrap.setPointerCapture(e.pointerId);
  waveSeek(e);
});
els.waveWrap.addEventListener("pointermove", (e) => {
  if (waveDragging) waveSeek(e);
});
els.waveWrap.addEventListener("pointerup", () => {
  waveDragging = false;
});
els.waveWrap.addEventListener("pointercancel", () => {
  waveDragging = false;
});

// ---------- decoder cross-check ----------
// loadedmetadata can fire before or after parseWav resolves, so this runs from both, never against a stale parse.
const DUR_TOL = 0.03;
function evalDecoderCheck() {
  const s = parsed && parsed.summary;
  if (audio.error) {
    if (parsed && !parsed.container) {
      problem(
        "decoder",
        "err",
        "Not a WAV file, and the browser cannot decode it either — nothing can be played or verified.",
      );
    } else {
      problem(
        "decoder",
        "err",
        `Browser cannot decode ${s ? s.formatName : "this encoding"} — playback unavailable.`,
      );
    }
    return;
  }
  if (audio.readyState < 1) return;
  els.dur.textContent = fmtTime(audio.duration);
  if (!parsed) return;
  if (!s) {
    renderSummary();
    return;
  }
  const d = audio.duration;
  if (s.headerDuration == null) {
    if (isFinite(d)) {
      problem(
        "decoder",
        "info",
        `Browser decoder measures ${fmtTime(d)} — the header does not reliably declare a duration to compare against.`,
      );
    }
    return;
  }
  if (!isFinite(d)) {
    problem(
      "decoder",
      "info",
      "Browser decoder could not determine a duration for this file.",
    );
    return;
  }
  const tol = Math.max(DUR_TOL, 2 / (s.sampleRate || 48000));
  if (Math.abs(d - s.headerDuration) <= tol) {
    problem("decoder", null, null);
    pass("decoder", "decoder duration");
  } else if (
    s.actualDuration != null &&
    Math.abs(d - s.actualDuration) <= tol
  ) {
    problem(
      "decoder",
      "warn",
      `Browser decoder reports ${fmtTime(d)} — it agrees with the bytes actually present, not the header's claim of ${fmtTime(s.headerDuration)}.`,
    );
  } else {
    problem(
      "decoder",
      "warn",
      `Browser decoder reports ${fmtTime(d)} but the header implies ${fmtTime(s.headerDuration)} — decoded audio disagrees with the file metadata.`,
    );
  }
}
audio.addEventListener("loadedmetadata", () => {
  els.dur.textContent = fmtTime(audio.duration);
  evalDecoderCheck();
});
audio.addEventListener("error", evalDecoderCheck);

// ---------- full decode verification ----------
// A decode holds the file plus float32 samples, so compressed audio needs many times its size; past this estimate it waits for the button.
const DEEP_AUTO_LIMIT = 512 * 1024 * 1024;
// Only for a file whose length isn't known before decoding (e.g. a browser-recorded WebM): low-bitrate Opus decodes to 100x its size or more, so this stays small — 64 MiB of it could be gigabytes of float32 and kill the tab before anything is shown.
const DEEP_AUTO_FILE_LIMIT = 4 * 1024 * 1024;
const decodeRate = (s) =>
  Math.min(192000, Math.max(8000, (s && s.sampleRate) || 48000));
// The bytes a full decode holds at once, or null when the length isn't known before decoding.
async function decodeCost(f, s) {
  let seconds = s && (s.truncated ? s.actualDuration : s.headerDuration);
  if (seconds == null) {
    if (audio.readyState < 1 && !audio.error) {
      await new Promise((resolve) => {
        audio.addEventListener("loadedmetadata", resolve, { once: true });
        audio.addEventListener("error", resolve, { once: true });
      });
    }
    seconds = audio.duration;
  }
  const cost = f.size + seconds * decodeRate(s) * ((s && s.channels) || 2) * 4;
  return Number.isFinite(cost) ? cost : null;
}
async function deepVerify(myGen) {
  if (!file) return;
  const stale = () => myGen !== gen;
  const s = parsed && parsed.summary;
  els.deepVerify.disabled = true;
  els.deepVerify.textContent = "Decoding…";
  deepDeferred = false;
  pending.add("deep");
  try {
    const buf = await file.arrayBuffer();
    if (stale()) return;
    const rate = decodeRate(s);
    const decoded = await new OfflineAudioContext(1, 1, rate).decodeAudioData(
      buf,
    );
    if (stale()) return;
    els.deepVerify.hidden = true;

    // Where the byte scanner can't run, the browser's decode is a second real measurement, not a guess, so it fills the gap.
    const canByteScan =
      s && s.frameBytes && s.availableDataBytes >= s.frameBytes && pcmCodec(s);
    const waveformFallback = canByteScan
      ? null
      : await computeWaveform(decoded, { isCancelled: stale });
    if (stale()) return;

    if (!s) {
      // The native sample rate would need a parser for that container, so it's withheld; both durations are named by source.
      metaRow("Duration (full decode)", fmtTime(decoded.duration));
      metaRow("Duration (player)", fmtTime(audio.duration));
      metaRow("Channels (full decode)", String(decoded.numberOfChannels));
      metaRow("Sample rate", notAvailableFor(file.name), true);
      if (waveformFallback) applyScanResult(waveformFallback);
      measuredChannels = decoded.numberOfChannels;
      renderSummary();
      pass("deep", "full decode");
      return;
    }
    if (waveformFallback) applyScanResult(waveformFallback);

    const resampled = rate !== s.sampleRate;
    const measured = resampled
      ? `${fmtTime(decoded.duration)}, ${decoded.numberOfChannels} ch (decoded at ${nf.format(rate)} Hz)`
      : `${nf.format(decoded.length)} frames, ${decoded.numberOfChannels} ch`;
    const bad = [];
    if (decoded.numberOfChannels !== s.channels) {
      bad.push(
        `decoder produced ${decoded.numberOfChannels} channel(s), header declares ${s.channels}`,
      );
    }
    const expectFrames = s.truncated ? s.actualFrames : s.headerFrames;
    if (expectFrames == null) {
      if (bad.length)
        problem(
          "deep",
          "warn",
          `Full decode disagrees with the header: ${bad.join("; ")}.`,
        );
      else
        problem(
          "deep",
          "info",
          `Full decode measures ${measured} — the header's frame count could not be verified against it.`,
        );
      return;
    }
    if (!resampled) {
      if (Math.abs(decoded.length - expectFrames) > 1) {
        bad.push(
          `decoder produced ${nf.format(decoded.length)} frames, header implies ${nf.format(expectFrames)}`,
        );
      }
    } else {
      const ref = s.truncated ? s.actualDuration : s.headerDuration;
      if (ref != null && Math.abs(decoded.duration - ref) > 0.05) {
        bad.push(
          `decoded duration ${fmtTime(decoded.duration)} vs ${s.truncated ? "measured (truncated)" : "header"} ${fmtTime(ref)}`,
        );
      }
    }
    if (bad.length)
      problem(
        "deep",
        "warn",
        `Full decode disagrees with the header: ${bad.join("; ")}.`,
      );
    else pass("deep", "full decode");
  } catch (err) {
    if (stale()) return;
    els.deepVerify.hidden = true;
    // If the element already reported it cannot play this, that error says it all.
    if (audio.error) {
      skip("deep");
      return;
    }
    problem(
      "deep",
      "info",
      `Full decode failed (${errText(err, "unsupported format")}).`,
    );
  }
}
els.deepVerify.addEventListener("click", () => deepVerify(gen));

// ---------- deferred autoplay ----------
// A drop or an OS "Open with" launch gives the page no user activation, so the browser refuses autoplay; the next click on the page starts it instead.
let disarmAutoplay = () => {};
function armDeferredAutoplay(myGen) {
  disarmAutoplay();
  // Bubble phase on window, so a click on Play has already toggled by then: this starts only what nothing else did, and any other start disarms it.
  const retry = () => {
    disarmAutoplay();
    if (myGen !== gen || !autoplay || !audio.paused) return;
    audio
      .play()
      .then(() =>
        toast(
          "Playing — your browser held autoplay back until you interacted with the page.",
        ),
      )
      .catch(() => {});
  };
  const disarm = () => {
    window.removeEventListener("click", retry);
    audio.removeEventListener("play", disarm);
    disarmAutoplay = () => {};
  };
  window.addEventListener("click", retry);
  audio.addEventListener("play", disarm);
  disarmAutoplay = disarm;
}

// ---------- loading ----------
function baselineChecks() {
  const codes = new Set(parsed.issues.map((i) => i.code));
  // A non-RIFF file is not a broken WAV — it is simply another format.
  notApplicable = !parsed.container;
  parsed.issues.forEach((issue, i) => {
    if (notApplicable) return;
    problems[`issue${i}`] = {
      level: issue.level === "error" ? "err" : issue.level,
      text: issue.message,
    };
  });
  if (notApplicable) {
    // The verdict line says it all; a bullet repeating it would be noise.
    pending.clear();
    renderIntegrity();
    return;
  }
  const s = parsed.summary;
  if (![...codes].some((c) => c.startsWith("ERR_")))
    verified.structure = "RIFF structure";
  if (
    s &&
    s.headerConsistent === true &&
    !["WARN_VALID_BITS", "WARN_FACT_MISMATCH", "WARN_ODD_BITS"].some((c) =>
      codes.has(c),
    )
  ) {
    verified.header = "header consistency";
  }
  if (
    s &&
    s.dataSize != null &&
    s.headerFrames != null &&
    !s.truncated &&
    !s.streamedSize &&
    !codes.has("WARN_RIFF_SIZE") &&
    !codes.has("WARN_DATA_ALIGN")
  ) {
    verified.length = "data length";
  }
  renderIntegrity();
}

async function load(f) {
  const myGen = ++gen;
  const stale = () => myGen !== gen;
  file = f;
  parsed = null;
  scan = null;
  problems = {};
  verified = {};
  notApplicable = false;
  deepDeferred = false;
  measuredChannels = null;
  pending = new Set(["parse"]);
  document.title = `${f.name} — ${PRODUCT}`;
  els.empty.hidden = true;
  els.player.hidden = false;
  els.filename.textContent = f.name;
  els.dur.textContent = "—";
  els.summary.textContent = "";
  els.issues.replaceChildren();
  els.verdict.textContent = "";
  els.meta.replaceChildren();
  els.details.open = false;
  els.waveMsg.hidden = true;
  els.scanProgress.style.width = "0";
  els.deepVerify.hidden = true;
  sizeCanvases();
  drawWave();

  // Start playback immediately — parsing runs in parallel.
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(f);
  audio.src = objectUrl;
  if (autoplay) {
    audio.play().catch((err) => {
      if (err && err.name === "NotAllowedError") armDeferredAutoplay(myGen);
    });
  }
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: f.name });
    } catch {}
  }

  try {
    parsed = await parseWav(f);
  } catch (err) {
    if (stale()) return;
    pending.clear();
    problem(
      "read",
      "err",
      `File could not be read (${errText(err, "read error")}) — it may have been moved or changed on disk. Re-open it to retry.`,
    );
    els.waveMsg.textContent = "No waveform — the file could not be read.";
    els.waveMsg.hidden = false;
    return;
  }
  if (stale()) return;
  const s = parsed.summary;
  const canByteScan = !!(
    s &&
    s.frameBytes &&
    s.availableDataBytes >= s.frameBytes &&
    pcmCodec(s)
  );
  const cost = await decodeCost(f, s);
  if (stale()) return;
  const autoDeep =
    cost === null ? f.size <= DEEP_AUTO_FILE_LIMIT : cost <= DEEP_AUTO_LIMIT;

  // Registered before any of them resolves, or the verdict could flash "Passed" while work is still outstanding.
  pending.delete("parse");
  if (parsed.container) {
    pending.add("decoder");
    if (autoDeep) pending.add("deep");
    if (canByteScan) pending.add("scan");
  }

  renderSummary();
  renderMeta();
  baselineChecks();
  evalDecoderCheck();

  if (autoDeep) {
    deepVerify(myGen);
  } else {
    deepDeferred = true;
    els.deepVerify.hidden = false;
    els.deepVerify.disabled = false;
    els.deepVerify.textContent = canByteScan
      ? `Verify full decode (loads ${fmtBytes(cost ?? f.size)} into memory)`
      : `Verify full decode & draw waveform (loads ${fmtBytes(cost ?? f.size)} into memory)`;
  }

  if (canByteScan) {
    let result;
    try {
      result = await scanAudio(f, parsed, {
        onProgress: (frac) => {
          if (!stale())
            els.scanProgress.style.width = `${(frac * 100).toFixed(1)}%`;
        },
        isCancelled: stale,
      });
    } catch (err) {
      if (stale()) return;
      els.scanProgress.style.width = "0";
      problem(
        "scan",
        "err",
        `Sample scan failed partway (${errText(err, "read error")}) — the file may have changed on disk while being read.`,
      );
      return;
    }
    if (stale() || !result) return;
    els.scanProgress.style.width = "0";
    applyScanResult(result);
    if (
      !s.truncated &&
      s.headerFrames != null &&
      result.frames !== s.headerFrames
    ) {
      problem(
        "scan",
        "warn",
        `Sample scan read ${nf.format(result.frames)} frames but the header implies ${nf.format(s.headerFrames)}.`,
      );
    } else {
      pass("scan", `sample scan (${nf.format(result.frames)} frames)`);
    }
  } else if (!s) {
    // Non-WAV: same waveform box and playhead, just nothing plotted in it.
    els.waveMsg.textContent = `Waveform ${notAvailableFor(file.name)}`;
    els.waveMsg.hidden = false;
  } else if (s.isLinear && s.headerConsistent === false) {
    els.waveMsg.textContent =
      "No waveform — header fields contradict each other, so frame boundaries cannot be trusted.";
    els.waveMsg.hidden = false;
  } else {
    els.waveMsg.textContent = `No waveform — ${s.formatName} is not decoded by the built-in scanner.`;
    els.waveMsg.hidden = false;
  }
}

// ---------- inputs ----------
els.openBtn.addEventListener("click", () => els.fileInput.click());
els.empty.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  // Read before clearing: setting `value` empties `files`, so the order matters.
  const [chosen] = els.fileInput.files;
  els.fileInput.value = "";
  if (chosen) load(chosen);
});

window.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("dragover");
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dragover");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragover");
  // Read synchronously: an `await` above this line leaves `dataTransfer.files` empty — the drag data store only answers while drop is dispatched.
  const [dropped] = e.dataTransfer ? e.dataTransfer.files : [];
  if (dropped) load(dropped);
});

if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files || !params.files.length) return;
    load(await params.files[0].getFile());
  });
}

// ---------- keyboard ----------
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  const seekBy = (d) => {
    if (isFinite(audio.duration))
      audio.currentTime = Math.min(
        Math.max(0, audio.currentTime + d),
        audio.duration,
      );
  };
  switch (k) {
    case " ":
    case "k":
      // A focused button already activates on Space; hijacking it would toggle twice.
      if (k === " " && e.target && e.target.tagName === "BUTTON") return;
      e.preventDefault();
      if (file) audio.paused ? audio.play().catch(() => {}) : audio.pause();
      break;
    case "ArrowLeft":
      e.preventDefault();
      seekBy(e.shiftKey ? -10 : -1);
      break;
    case "ArrowRight":
      e.preventDefault();
      seekBy(e.shiftKey ? 10 : 1);
      break;
    case "Home":
      e.preventDefault();
      audio.currentTime = 0;
      break;
    case "ArrowUp":
    case "ArrowDown": {
      e.preventDefault();
      audio.volume = Math.min(
        1,
        Math.max(
          0,
          Math.round((audio.volume + (k === "ArrowUp" ? 0.1 : -0.1)) * 10) / 10,
        ),
      );
      prefSet(PREF_VOLUME, String(audio.volume));
      toast(`Volume ${Math.round(audio.volume * 100)}%`);
      break;
    }
    case "a":
    case "A":
      els.autoplay.click();
      break;
    case "l":
    case "L":
      els.loop.click();
      break;
    case "o":
    case "O":
      els.fileInput.click();
      break;
  }
});
const savedVolume = parseFloat(prefGet(PREF_VOLUME, ""));
if (isFinite(savedVolume) && savedVolume >= 0 && savedVolume <= 1)
  audio.volume = savedVolume;

if ("mediaSession" in navigator) {
  try {
    navigator.mediaSession.setActionHandler("play", () =>
      audio.play().catch(() => {}),
    );
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  } catch {}
}

// ---------- PWA ----------
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  els.installBtn.hidden = false;
});
els.installBtn.addEventListener("click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  els.installBtn.hidden = true;
});
// Lock names are origin-wide and sibling apps share this origin, so this one carries the package name.
const WINDOW_LOCK = "audio-file-inspector-window";

// An update downloads in the background and runs from the next reload: a new worker waiting by then takes over, unless another window of this app is still open on the current version. A fresh "Open with" launch is never a reload (see the launchQueue consumer above), so this never costs it its launch params.
async function applyWaitingUpdate() {
  // Asked for before anything else and held until this window closes, so another window's check below always finds this one.
  const locked = new Promise((resolve) => {
    navigator.locks.request(WINDOW_LOCK, { mode: "shared" }, () => {
      resolve();
      return new Promise(() => {});
    });
  });
  // Asked for at once too, not once the lock is granted: a long boot can hold up the grant, and an update that finished downloading meanwhile must wait for the next reload.
  const waiting = (await navigator.serviceWorker.getRegistration())?.waiting;
  const [navigation] = performance.getEntriesByType("navigation");
  await locked;
  if (
    !waiting ||
    navigation?.type !== "reload" ||
    !navigator.serviceWorker.controller ||
    (await otherWindowOpen(WINDOW_LOCK))
  ) {
    return;
  }
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    () => location.reload(),
    { once: true },
  );
  waiting.postMessage({ type: "SKIP_WAITING" });
}

// This window holds the lock as well, so a second hold is another window's, or for a moment after a reload the page it replaced, which can still be listed after it has gone: a second hold counts only once it has lasted a quarter of a second.
async function otherWindowOpen(name, start = performance.now()) {
  const holds =
    (await navigator.locks.query()).held?.filter((lock) => lock.name === name)
      .length ?? 0;
  if (holds < 2 || performance.now() - start >= 250) return holds > 1;
  await new Promise((resolve) => setTimeout(resolve, 25));
  return otherWindowOpen(name, start);
}

// Only where a worker can install: a page opened from disk has no worker scope.
if (
  "serviceWorker" in navigator &&
  (location.protocol === "https:" ||
    ["localhost", "127.0.0.1"].includes(location.hostname))
) {
  // The update tests wait for this mark to know the check is over, whichever way it went.
  if (navigator.locks)
    applyWaitingUpdate()
      .catch(() => {})
      .finally(() => performance.mark("update-checked"));
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("sw.js").catch(() => {}),
  );
}
window.addEventListener("pagehide", () => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});
