// Built here (not found) because dist/ isn't committed; served via a hand-rolled static server, not `vite preview`, since Playwright's real-Chromium navigations refuse an empty-body 404.
import { execFileSync } from "node:child_process";
import http from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SITE = join(ROOT, "dist");

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".md": "text/markdown",
};

export async function serve(dir, { port = 0, host = "127.0.0.1" } = {}) {
  const root = resolve(dir);
  const server = http.createServer((request, response) => {
    let path;
    try {
      path = decodeURIComponent((request.url ?? "/").split(/[?#]/u, 1)[0]);
    } catch {
      // A malformed percent-encoding throws rather than returning a value; one bad request must answer 400, not take the whole server down.
      response.writeHead(400).end("bad request");
      return;
    }
    const file = join(root, path === "/" ? "index.html" : path);
    // Resolved and compared against the root, so an encoded `..` cannot reach outside it.
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(readFileSync(file));
  });
  await new Promise((listening) => server.listen(port, host, listening));
  server.url = `http://${host}:${server.address().port}/`;
  return server;
}

export async function serveBuiltSite(label) {
  try {
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
  } catch (error) {
    console.error(`[${label}] \`npm run build\` failed: ${error.message}`);
    process.exit(1);
  }
  if (!existsSync(join(SITE, "index.html"))) {
    console.error(`[${label}] the build produced no dist/index.html.`);
    process.exit(1);
  }
  return serve(SITE);
}
