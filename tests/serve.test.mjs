import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { resolve } from "node:path";
import { serve } from "./site.mjs";

const SRC = resolve(import.meta.dirname, "..", "src");

function get(base, path) {
  return new Promise((resolve, reject) => {
    http
      .get(base + path, (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode));
      })
      .on("error", reject);
  });
}

test("a malformed percent-encoded path answers 400 and the server keeps serving", async () => {
  const server = await serve(SRC, { port: 0 });
  try {
    // A truncated percent-escape throws from decodeURIComponent; one bad request must not take the process down for every request after it.
    assert.equal(await get(server.url, "/%E0%A4%A"), 400);
    assert.equal(await get(server.url, "/index.html"), 200);
  } finally {
    server.close();
  }
});
