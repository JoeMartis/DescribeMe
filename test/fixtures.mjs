// Test media synthesised in a headless page: PNG/JPEG slides via canvas, a
// WebM video via MediaRecorder. Returns Buffers usable with setInputFiles.
//
// Also the two things every suite needs from its environment: where the app
// is being served, and where to put files a test writes. run.mjs sets both,
// since it owns the server and picks the port.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where the app under test is served. The default is for running one suite
    by hand against a server you started yourself. */
export const APP_URL = process.env.DESCRIBEME_URL || "http://127.0.0.1:8110/index.html";

/** Scratch directory for downloads and screenshots a suite writes. Gitignored
    — nothing in it is an input to anything. */
export function outDir() {
  const dir = process.env.DESCRIBEME_OUT || path.join(HERE, ".out");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function launch(opts = {}) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  const page = await ctx.newPage();
  // The app confirms before replacing an unsaved batch; Playwright dismisses
  // dialogs by default, which silently cancels the action under test.
  page.on("dialog", (d) => d.accept());
  const problems = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`[console.error] ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.error(`CSP: ${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });
  return { b, ctx, page, problems };
}

/** A slide image with a label drawn on it. type: "image/png" | "image/jpeg" */
export async function makeImage(page, { w = 1600, h = 900, label = "slide", type = "image/png" } = {}) {
  const dataUrl = await page.evaluate(({ w, h, label, type }) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
    g.fillStyle = "#123"; g.font = `${Math.round(h / 8)}px sans-serif`;
    g.fillText(label, 40, h / 2);
    return c.toDataURL(type, 0.9);
  }, { w, h, label, type });
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

/** A short WebM whose frames show the elapsed second as a big number. */
export async function makeVideo(page, { seconds = 6, fps = 10, w = 640, h = 360 } = {}) {
  const dataUrl = await page.evaluate(async ({ seconds, fps, w, h }) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    const stream = c.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start(100);
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const t = (performance.now() - t0) / 1000;
        g.fillStyle = `hsl(${(t * 60) % 360} 60% 90%)`; g.fillRect(0, 0, w, h);
        g.fillStyle = "#000"; g.font = "120px sans-serif";
        g.fillText(String(Math.floor(t)), 60, 220);
        if (t < seconds) requestAnimationFrame(tick); else resolve();
      };
      tick();
    });
    rec.stop();
    await done;
    const blob = new Blob(chunks, { type: "video/webm" });
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
  }, { seconds, fps, w, h });
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

export function srt(cues) {
  // cues: [{start, end, text}] seconds
  const ts = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
  };
  return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join("\n") + "\n";
}

/** Skip onboarding and land in the workspace. */
export async function openWorkspace(page, url = APP_URL) {
  await page.goto(url, { waitUntil: "load" });
  // Onboarding only shows until it has been completed once — a second visit
  // in the same context lands straight in the workspace.
  if (!(await page.$eval("#onboarding", (o) => o.hidden))) await page.click("#onboardSkip");
}

/** Add files to the batch through the real file input. */
export async function addFiles(page, files) {
  // files: [{name, mimeType, buffer}]
  await page.setInputFiles("#fileInput, #railFileInput", files);
}
