#!/usr/bin/env node
// Runs every suite against a server this script owns.
//
// The suites all drive a real browser against a real HTTP origin — the app
// uses modules, IndexedDB and a CSP, none of which behave the same over
// file://. Starting that server by hand is a step easy to forget, and
// forgetting it produces a run that fails for a reason nothing on screen
// explains. So the runner starts one, on a port it picks, and passes the URL
// down through DESCRIBEME_URL.
//
//   node test/run.mjs              — everything
//   node test/run.mjs regress8     — one suite (name, with or without .mjs)
//
// Exits non-zero if any suite fails, so it can gate a commit or a workflow.

import { spawn } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".ico": "image/x-icon",
};

// A deliberately dull static server: no directory listing, no rewriting, and
// every path resolved back inside the repo before it is opened.
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const file = path.join(ROOT, rel === "/" ? "/index.html" : rel);
      if (!file.startsWith(ROOT + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] || "application/octet-stream" });
      createReadStream(file).pipe(res);
    });
    // Port 0 — the OS picks a free one, so a stale server from an earlier run
    // (or anything else on 8110) cannot silently serve the wrong files.
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const only = process.argv.slice(2).map((a) => a.replace(/\.mjs$/, ""));
const suites = readdirSync(HERE)
  .filter((f) => /^(smoke|regress\d*)\.mjs$/.test(f))
  .sort((a, b) => {
    // smoke first, then regress, regress2, regress3 … numerically, so a
    // failure is read in the order the app was built up.
    const rank = (f) => (f === "smoke.mjs" ? -1 : Number(f.match(/\d+/)?.[0] ?? 1));
    return rank(a) - rank(b);
  })
  .filter((f) => only.length === 0 || only.includes(f.replace(/\.mjs$/, "")));

if (suites.length === 0) {
  console.error(only.length ? `No suite matching: ${only.join(", ")}` : "No suites found.");
  process.exit(1);
}

const { server, port } = await serve();
const url = `http://127.0.0.1:${port}/index.html`;
console.log(`serving ${ROOT} at ${url}\n`);

const failed = [];
for (const suite of suites) {
  process.stdout.write(`── ${suite}\n`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, suite)], {
      stdio: "inherit",
      env: { ...process.env, DESCRIBEME_URL: url },
    });
    child.on("close", resolve);
  });
  if (code !== 0) failed.push(suite);
  process.stdout.write("\n");
}

server.close();

if (failed.length) {
  console.log(`FAILED: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`All ${suites.length} suite${suites.length === 1 ? "" : "s"} passed.`);
