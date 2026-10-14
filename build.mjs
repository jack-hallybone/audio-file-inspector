// Stages the site into dist/, then generates the service worker.
import { cp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { generateSW } from "workbox-build";

const OUT = "dist";

await rm(OUT, { recursive: true, force: true });
// src/ becomes dist/ itself (not nested), because cp only nests under an existing destination — creating dist fresh flattens it.
await cp("src", OUT, { recursive: true });
// THIRD-PARTY-NOTICES.md ships too — a notice only a repository reader can find has not actually been given.
await cp("THIRD-PARTY-NOTICES.md", `${OUT}/THIRD-PARTY-NOTICES.md`);

// Workbox writes sw.js into the directory it globbed, after globbing it, so the worker never precaches itself.
// No read-time digest check on precached bytes. That is the accepted cost of the shared github.io origin: a page from any project on it can rewrite this cache, and the worker would go on serving what it wrote on later launches too.
const { count, size, warnings } = await generateSW({
  globDirectory: OUT,
  globPatterns: [
    "index.html",
    "manifest.webmanifest",
    "THIRD-PARTY-NOTICES.md",
    "*.js",
    "*.css",
    "icons/**/*.{svg,png}",
  ],
  swDest: `${OUT}/sw.js`,
  // Cache Storage is origin-wide and github.io is shared, so caches are named for this project, not left on Workbox's default.
  cacheId: JSON.parse(readFileSync("package.json", "utf8")).name,
  // One file rather than a worker plus a runtime chunk beside it.
  inlineWorkboxRuntime: true,
  mode: "production",
  // Nothing here is this project's source, and a map is 150 KB published for nobody.
  sourcemap: false,
  cleanupOutdatedCaches: true,
  // A navigation to the scope root is answered by the precached page.
  navigateFallback: "index.html",
  // This app has no routes, so any other navigation is a bad link — excluding anything whose last path segment has a dot answers with a real 404, not the app shell. Only that segment's first dot is tried, which gives the same verdicts as trying every dot but can't backtrack for seconds on a long crafted path.
  navigateFallbackDenylist: [/\/[^/?][^/?.]*\.[^/]+$/],
  // No skipWaiting or clientsClaim: taking over mid-session would let a page load half of one build and half of the next. The page may ask a waiting worker to take over on a reload instead (see applyWaitingUpdate in src/main.js).
});

for (const warning of warnings) console.warn(warning);
console.log(`${OUT}/sw.js: precaches ${count} files, ${size} bytes`);
