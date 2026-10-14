// A waiting worker takes over on a reload once no other window of the app is open, and stays waiting while one is.

//   node --test tests/sw-update.test.mjs   (builds the site; needs playwright's chromium)
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { chromium } from "playwright";

import { serve, serveBuiltSite } from "./site.mjs";

// Must match WINDOW_LOCK in src/main.js.
const WINDOW_LOCK = "audio-file-inspector-window";

let copy;
let site;
let browser;

// Served from a copy, since the test changes sw.js and deploy.yml publishes dist/ as verify leaves it.
before(async () => {
  (await serveBuiltSite("sw-update")).close();
  copy = await mkdtemp(join(tmpdir(), "sw-update-"));
  await cp(join(import.meta.dirname, "..", "dist"), copy, { recursive: true });
  site = await serve(copy);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await new Promise((closed) => site.close(closed));
  await rm(copy, { recursive: true, force: true });
});

// page.waitForFunction settles at once on an async predicate here, so this polls page.evaluate().
async function waitForAsync(page, fn, arg, timeoutMs, intervalMs = 200) {
  const start = Date.now();
  for (;;) {
    if (await page.evaluate(fn, arg)) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test("a reload switches to a waiting worker only once no other window is open", async () => {
  const context = await browser.newContext();
  const swPath = join(copy, "sw.js");
  try {
    const page = await context.newPage();
    await page.goto(site.url);
    await page.evaluate(() => navigator.serviceWorker.ready);
    // No clientsClaim here: the first load isn't controlled, so one reload is needed first.
    await page.reload();
    await page.evaluate(() => navigator.serviceWorker.ready);
    assert.ok(
      await page.evaluate(() => !!navigator.serviceWorker.controller),
      "the page is not controlled after its second load",
    );

    let loads = 0;
    // DOMContentLoaded, not load: the self-reload can replace the reloaded document before its load event fires.
    page.on("domcontentloaded", () => loads++);

    // Opened once a worker is active, so it's controlled from the start and holds WINDOW_LOCK.
    const other = await context.newPage();
    await other.goto(site.url);
    assert.ok(
      await other.evaluate(() => !!navigator.serviceWorker.controller),
      "the second window was not controlled from the start",
    );

    // A byte-different sw.js is a new worker, so a trailing comment stands in for a second deploy.
    await writeFile(
      swPath,
      (await readFile(swPath, "utf8")) + "\n// deploy 2\n",
    );
    await waitForAsync(
      page,
      async () => {
        const r = await navigator.serviceWorker.getRegistration();
        r?.update().catch(() => {});
        return r?.waiting?.state === "installed";
      },
      undefined,
      30000,
    );

    let before = loads;
    await page.reload();
    // Until this reload's own update check is over, not for a set time: on a busy machine the check, which waits a quarter of a second while another window is open, can outlast a set wait, and if it is still running when that window closes it rightly takes the update. The mark is set where src/main.js starts the check.
    await page.waitForFunction(
      () => performance.getEntriesByName("update-checked").length > 0,
      undefined,
      { timeout: 20_000 },
    );
    // A settle, since this checks that nothing more happens.
    await page.waitForTimeout(500);
    assert.equal(
      loads - before,
      1,
      "a reload with a second window open should not have self-reloaded",
    );
    assert.equal(
      await page.evaluate(
        async () =>
          (await navigator.serviceWorker.getRegistration())?.waiting?.state,
      ),
      "installed",
      "the waiting worker should still be waiting while a second window is open",
    );

    await other.close();
    // Down to `page`'s own hold of the lock.
    assert.ok(
      await waitForAsync(
        page,
        async (name) => {
          const held = (await navigator.locks.query()).held ?? [];
          return held.filter((l) => l.name === name).length <= 1;
        },
        WINDOW_LOCK,
        5000,
      ),
      "the closed window still holds its lock",
    );

    before = loads;
    await page.reload();
    const start = Date.now();
    while (loads < before + 2 && Date.now() - start < 20000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(
      loads - before,
      2,
      "a reload with no other window open should land on the new worker via one extra, self-triggered load",
    );
    assert.equal(
      await page.evaluate(
        async () => (await navigator.serviceWorker.getRegistration())?.waiting,
      ),
      null,
      "no worker should be left waiting after the switch — it is the one now active",
    );
    assert.ok(
      await page.evaluate(() => !!navigator.serviceWorker.controller),
      "the page should still be controlled after the switch",
    );
  } finally {
    await context.close();
  }
});
