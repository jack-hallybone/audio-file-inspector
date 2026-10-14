// The built site, in a real browser; tone.webm is committed because it needs an encoder this repository doesn't have.

//   node --test tests/e2e.test.mjs   (builds the site; needs playwright's chromium)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";

import { chromium } from "playwright";

import { buildWav } from "./fixtures.mjs";
import { serveBuiltSite } from "./site.mjs";

const sine = (rate, frames, amp = 0.6, freq = 330) => {
  const buf = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(
      Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / rate)),
      i * 2,
    );
  }
  return buf;
};

// A short stereo phrase: four plucked notes, so the waveform has visible shape and a stable, hand-checkable status line.
function pluckWav() {
  const rate = 44100;
  const notes = [220, 277.18, 329.63, 440];
  const beat = 0.6;
  const frames = Math.round(rate * beat * notes.length);
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const n = Math.min(notes.length - 1, Math.floor(t / beat));
    const tt = t - n * beat;
    const env = Math.exp(-3 * tt) * (1 - Math.exp(-200 * tt));
    buf.writeInt16LE(
      Math.round(0.75 * env * Math.sin(2 * Math.PI * notes[n] * t) * 32767),
      i * 4,
    );
    buf.writeInt16LE(
      Math.round(
        0.75 * env * Math.sin(2 * Math.PI * notes[n] * 1.5 * t) * 32767,
      ),
      i * 4 + 2,
    );
  }
  return buildWav({ fmt: { channels: 2, sampleRate: rate }, data: buf });
}

// The header claims one second; 40% of the audio is not there.
const truncatedWav = () =>
  buildWav({
    fmt: { sampleRate: 44100 },
    data: sine(44100, 44100),
    truncate: Math.round(44100 * 0.4) * 2,
  });

// byteRate contradicts sampleRate x frame size, so no derived value can be trusted.
const inconsistentWav = () =>
  buildWav({
    fmt: { sampleRate: 44100, byteRate: 44100 * 2 + 100 },
    data: sine(44100, 44100),
  });

const toneWebm = () =>
  readFileSync(path.join(import.meta.dirname, "fixtures", "tone.webm"));
const notAudio = () =>
  Buffer.from("This is a text file, not audio at all.\n".repeat(20));

let site;
let browser;
let page;
let errors = [];

const open = (name, mimeType, buffer) =>
  page.setInputFiles("#file-input", { name, mimeType, buffer });

// `setInputFiles` reaches none of the drop path — firing the window-level listeners needs a DragEvent/DataTransfer built inside the page.
async function dragEvent(type, file) {
  await page.evaluate(
    ({ type, name, mimeType, b64 }) => {
      const dt = new DataTransfer();
      if (b64) {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        dt.items.add(new File([bytes], name, { type: mimeType }));
      }
      window.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }),
      );
    },
    {
      type,
      name: file?.name ?? null,
      mimeType: file?.mimeType ?? null,
      b64: file ? file.buffer.toString("base64") : null,
    },
  );
}

before(async () => {
  site = await serveBuiltSite("e2e");
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1000, height: 860 } });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.goto(site.url);
  await page.waitForSelector("#empty");
});

after(async () => {
  await browser?.close();
  await new Promise((closed) => site.close(closed));
});

test("the empty state opens the platform's own file picker", async () => {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.click("#empty"),
  ]);
  await chooser.setFiles({
    name: "pluck.wav",
    mimeType: "audio/wav",
    buffer: pluckWav(),
  });
  await page.waitForSelector("#verdict.ok");
  await page.waitForSelector("#empty", { state: "hidden" });
});

test("a file dragged over the page is offered a target, open file or not", async () => {
  await dragEvent("dragover");
  await page.waitForFunction(() =>
    document.body.classList.contains("dragover"),
  );
  assert.notEqual(
    await page.evaluate(
      () => getComputedStyle(document.getElementById("player")).outlineStyle,
    ),
    "none",
    "nothing on screen says the page will take the drop while a file is open",
  );
  await dragEvent("dragleave");
  await page.waitForFunction(
    () => !document.body.classList.contains("dragover"),
  );
});

test("a file dropped on an open one replaces it", async () => {
  // Does not cover the handler's synchronous read: a script-built DataTransfer never enters protected mode, so this synthetic drop passes either way.
  await dragEvent("drop", {
    name: "dropped.wav",
    mimeType: "audio/wav",
    buffer: truncatedWav(),
  });
  await page.waitForSelector('#filename:text-is("dropped.wav")');
  // The newly dropped file's own finding, not the previous file's.
  await page.waitForSelector("text=file is truncated");
});

test("a clean WAV reports its format and every check that ran", async () => {
  await open("pluck.wav", "audio/wav", pluckWav());
  await page.waitForSelector("#verdict.ok");
  await page.waitForSelector("#empty", { state: "hidden" });
  // Format facts and the verdict are ONE sentence, and the separator is real text so it survives copy-paste and a screen reader.
  assert.equal(
    (await page.textContent("#status")).trim(),
    "2 ch · 44,100 Hz · 16-bit · PCM (integer) · 413 KB · ✓ Passed",
  );
  assert.equal((await page.textContent("#details summary")).trim(), "Details");
  const mainWidth = () =>
    page.evaluate(
      () =>
        document.querySelector("main.measure").getBoundingClientRect().width,
    );
  const closedWidth = await mainWidth();
  const chevronTransform = () =>
    page.evaluate(
      () =>
        getComputedStyle(document.querySelector("#details .chevron")).transform,
    );
  const chevronClosed = await chevronTransform();
  await page.click("#details summary");
  await page.waitForSelector("text=Audio data");
  // Regression: opening this used to widen main's shrink-to-fit box past its closed size.
  assert.equal(
    await mainWidth(),
    closedWidth,
    "the page changed width when Details opened",
  );
  // Give the chevron's CSS transition time to actually finish before reading it back.
  await page.waitForFunction(
    (before) =>
      getComputedStyle(document.querySelector("#details .chevron"))
        .transform !== before,
    chevronClosed,
  );
  const checks = await page.textContent("#checks");
  for (const ran of [
    "RIFF structure",
    "header consistency",
    "data length",
    "decoder duration",
    "full decode",
    "sample scan",
  ]) {
    assert.ok(checks.includes(ran), `the checks-run list omits ${ran}`);
  }
});

test("a truncated WAV cannot read as clean", async () => {
  await open("truncated.wav", "audio/wav", truncatedWav());
  await page.waitForSelector("text=file is truncated");
  await page.waitForSelector("#issues .lv-err");
  await page.waitForSelector("text=agrees with the bytes actually present");
  await page.waitForSelector("#verdict.fail");
  assert.equal(
    await page.locator("#verdict.ok").count(),
    0,
    "a truncated file was reported as passing",
  );
  // A long sentence's unwrapped width is what .row's flex-wrap measures; a missing min-width:0 sends it to a line under the icon.
  const iconBox = await page
    .locator("#issues .lv-err .issue-icon")
    .boundingBox();
  const textBox = await page
    .locator("#issues .lv-err .issue-text")
    .boundingBox();
  assert.ok(
    Math.abs(iconBox.y - textBox.y) < iconBox.height,
    "the issue icon and its sentence landed on different lines",
  );
});

test("a self-contradictory header withholds, and still draws a real waveform", async () => {
  await open("inconsistent.wav", "audio/wav", inconsistentWav());
  await page.waitForSelector("text=byteRate");
  await page.waitForSelector("#verdict.fail");
  await page.click("#details summary");
  await page.waitForSelector(
    "text=withheld — header fields contradict each other",
  );
  // The browser's own decode doesn't depend on trusting the header, so it measures a real waveform where the byte scanner refuses to guess.
  await page.waitForSelector("text=Peak level (measured)");
  await page.waitForSelector("#wave-msg", { state: "hidden" });
});

test("a playable non-WAV claims only what was measured, in one shared phrase", async () => {
  await open("tone.webm", "audio/webm", toneWebm());
  await page.waitForSelector("text=checks not available for .webm files");
  assert.equal(
    (await page.textContent("#issues")).trim(),
    "",
    "a file that plays and makes no WAV claims needs no issue bullets",
  );
  await page.waitForSelector("#wave-wrap", { state: "visible" });
  await page.waitForFunction(
    () => document.getElementById("cursor").getBoundingClientRect().width > 0,
  );
  await page.waitForFunction(
    () =>
      document.getElementById("status").textContent.trim() ===
      "2 ch · 23.9 KB · checks not available for .webm files",
  );
  await page.click("#details summary");
  await page.waitForSelector("text=Peak level (measured)");
  await page.waitForSelector("#wave-msg", { state: "hidden" });
  // Container and Sample rate must read exactly as the verdict does: one phrase, not three ways of saying the same thing.
  assert.equal(
    await page
      .locator('#meta dd:text-is("not available for .webm files")')
      .count(),
    2,
  );
  const meta = await page.textContent("#meta");
  for (const row of [
    "Duration (full decode)",
    "Duration (player)",
    "Channels (full decode)",
    "RMS level (measured)",
  ]) {
    assert.ok(meta.includes(row), `the non-WAV field list omits ${row}`);
  }
  assert.doesNotMatch(
    meta,
    /Encoding|Bit depth|declared/,
    "a non-WAV file was given WAV header fields",
  );
});

test("a file with no extension gets the same sentence, generically", async () => {
  await open("tone_no_extension", "audio/webm", toneWebm());
  await page.waitForSelector("text=checks not available for this file type");
  await page.click("#details summary");
  assert.equal(
    await page
      .locator('#meta dd:text-is("not available for this file type")')
      .count(),
    2,
  );
});

test("an undecodable file gets one error and no phantom waveform", async () => {
  await open("notes.txt", "text/plain", notAudio());
  await page.waitForSelector("text=cannot decode it either");
  await page.waitForSelector("text=Waveform not available for .txt files");
  assert.doesNotMatch(
    await page.textContent("#issues"),
    /playing it/,
    "a file that cannot be decoded also claimed to play",
  );
});

test("the autoplay choice survives a reload and is honoured on the next open", async () => {
  await open("pluck.wav", "audio/wav", pluckWav());
  await page.waitForFunction(() => !document.getElementById("audio").paused);
  await page.click("#autoplay");
  await page.reload();
  await page.waitForSelector("#empty");
  assert.equal(
    await page.getAttribute("#autoplay", "aria-pressed"),
    "false",
    "the autoplay preference did not survive a reload",
  );
  await open("pluck.wav", "audio/wav", pluckWav());
  await page.waitForSelector("#verdict.ok");
  assert.equal(
    await page.evaluate(() => document.getElementById("audio").paused),
    true,
    "a file started playing with autoplay off",
  );
  await page.click("#play");
  await page.waitForFunction(() => !document.getElementById("audio").paused);
  // Restore the shipped default, so the cases after this one see a normal install.
  await page.click("#autoplay");
  await page.reload();
  await page.waitForSelector('#autoplay[aria-pressed="true"]', {
    state: "attached",
  });
});

test("a blocked autoplay retries on the next interaction and says so", async () => {
  // This suite's headless launch grants every page activation on navigation, so audio.play()
  // never actually gets NotAllowedError here the way it does for a file dropped with no prior
  // gesture. Forcing the one rejection Chrome would otherwise raise still exercises the app's own
  // recovery: an isolated context/page so it doesn't touch the autoplay preference the other cases
  // share.
  const context = await browser.newContext();
  try {
    const isolated = await context.newPage();
    await isolated.addInitScript(() => {
      const real = HTMLMediaElement.prototype.play;
      let first = true;
      HTMLMediaElement.prototype.play = function () {
        if (first) {
          first = false;
          return Promise.reject(new DOMException("blocked", "NotAllowedError"));
        }
        return real.call(this);
      };
    });
    await isolated.goto(site.url);
    await isolated.waitForSelector("#empty");
    await isolated.setInputFiles("#file-input", {
      name: "pluck.wav",
      mimeType: "audio/wav",
      buffer: pluckWav(),
    });
    await isolated.waitForSelector("#verdict.ok");
    assert.equal(
      await isolated.evaluate(() => document.getElementById("audio").paused),
      true,
      "the simulated NotAllowedError should have left playback paused",
    );
    // Any interaction on the page is the "next activation" — click blank header space for one.
    await isolated.mouse.click(10, 10);
    await isolated.waitForFunction(
      () => !document.getElementById("audio").paused,
    );
    await isolated.waitForSelector("#toast.show");
    assert.match(
      await isolated.textContent("#toast"),
      /held autoplay back/,
      "nothing told the user why playback only started after they clicked",
    );
  } finally {
    await context.close();
  }
});

test("after a blocked autoplay, Play plays, and a later click doesn't restart what the reader paused", async () => {
  const context = await browser.newContext();
  try {
    const isolated = await context.newPage();
    await isolated.addInitScript(() => {
      const real = HTMLMediaElement.prototype.play;
      let first = true;
      HTMLMediaElement.prototype.play = function () {
        if (first) {
          first = false;
          return Promise.reject(new DOMException("blocked", "NotAllowedError"));
        }
        return real.call(this);
      };
    });
    await isolated.goto(site.url);
    await isolated.waitForSelector("#empty");
    await isolated.setInputFiles("#file-input", {
      name: "pluck.wav",
      mimeType: "audio/wav",
      buffer: pluckWav(),
    });
    await isolated.waitForSelector("#verdict.ok");
    const paused = () =>
      isolated.evaluate(() => document.getElementById("audio").paused);
    await isolated.click("#play");
    await isolated.waitForFunction(
      () => !document.getElementById("audio").paused,
    );
    await isolated.click("#play");
    assert.equal(await paused(), true, "the second press of Play should pause");
    await isolated.mouse.click(10, 10);
    assert.equal(
      await paused(),
      true,
      "a click after the reader paused must not restart playback",
    );
  } finally {
    await context.close();
  }
});

test("the waveform is painted in ink that follows the reader's scheme", async () => {
  // The PIXELS, not the stylesheet — a computed-style assertion would pass even if main.js read the token wrongly.
  await open("pluck.wav", "audio/wav", pluckWav());
  await page.waitForSelector("#verdict.ok");
  const inkFor = async (colorScheme) => {
    await page.emulateMedia({ colorScheme });
    return page.evaluate(async () => {
      const canvas = document.getElementById("wave");
      // The redraw runs off a matchMedia listener, a separate task from Playwright's emulateMedia — 1 frame flaked 3/3, 3 frames gave 5/5 clean runs.
      for (let i = 0; i < 3; i++) {
        await new Promise((drawn) => requestAnimationFrame(() => drawn()));
      }
      const { data } = canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 200)
          return `${data[i]},${data[i + 1]},${data[i + 2]}`;
      }
      return null;
    });
  };
  const light = await inkFor("light");
  const dark = await inkFor("dark");
  assert.ok(
    light,
    "nothing was painted into the waveform canvas in light mode",
  );
  assert.ok(dark, "nothing was painted into the waveform canvas in dark mode");
  assert.notEqual(
    light,
    dark,
    "both schemes painted the waveform the same ink",
  );
  // The RESOLVED colour, not a pixel — the cursor's antialiased line has no fully-opaque pixel to sample, so pixel comparison would mask a lost-retint collision.
  const [waveColor, cursorColor] = await page.evaluate(() => [
    getComputedStyle(document.getElementById("wave")).color,
    getComputedStyle(document.getElementById("cursor")).color,
  ]);
  assert.notEqual(
    waveColor,
    cursorColor,
    "the playhead resolves to the same colour as the waveform behind it",
  );
  await page.emulateMedia({ colorScheme: null });
});

test("the shipped page carries a version in its footer", async () => {
  // The anchor ships as plain markup ("v. dev" unless deploy.yml already stamped it) — this test guards it staying present, not its exact text.
  const stamped = await page.textContent("#version");
  assert.ok(stamped?.trim(), "the footer shipped with no version in it");
});

test("the app refuses to run inside another site's frame", async () => {
  // Its own page: a framed app fails to start, and that console error is the intended outcome, not something the last case should see.
  const host = await browser.newPage();
  try {
    await host.setContent(
      `<iframe src="${site.url}" width="900" height="700"></iframe>`,
    );
    const framed = await (await host.waitForSelector("iframe")).contentFrame();
    await framed.waitForSelector("#framerefusal");
    for (const control of ["#open-btn", "#empty", "#file-input"]) {
      assert.equal(
        await framed.locator(control).count(),
        0,
        `${control} survived being framed, so it is still under the attacker's cursor`,
      );
    }
  } finally {
    await host.close();
  }
});

test("the offline worker installs and takes over", async () => {
  const active = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return false;
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((r) => setTimeout(() => r(null), 5000)),
    ]);
    return !!registration?.active;
  });
  assert.ok(active, "no service worker activated, so there is no offline copy");
});

test("a nonexistent file-shaped path 404s instead of loading the app shell", async () => {
  // Regression: any bad file link would otherwise get 200'd as the app shell instead of 404, since navigateFallback answers everything unless denylisted.
  const context = await browser.newContext();
  try {
    const worker = await context.newPage();
    await worker.goto(site.url);
    await worker.evaluate(() => navigator.serviceWorker.ready);

    const response = await worker.goto(
      new URL("nonexistent-file.txt", site.url).href,
    );
    assert.equal(response.status(), 404);
    assert.ok(
      !(await response.text()).includes("<!doctype html>"),
      "got the app shell instead of a 404",
    );
  } finally {
    await context.close();
  }
});

test("every origin-wide name this app writes is its own", async () => {
  // github.io is one origin shared with every project published there, and Cache Storage/localStorage are origin-wide.
  const names = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    return [...(await caches.keys()), ...Object.keys(localStorage)];
  });
  assert.ok(
    names.some((name) => name.includes("precache")),
    "no precache was created, so this measured nothing",
  );
  for (const name of names) {
    assert.match(
      name,
      /^audio-file-inspector/u,
      `"${name}" is not namespaced, so a sibling project can collide with it`,
    );
  }
});

test("the app logged nothing broken along the way", () => {
  assert.deepEqual(errors, []);
});
