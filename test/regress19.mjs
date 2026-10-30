// No batch limit. A batch used to stop at 25 slides, and some lectures run to
// 75 visuals. This takes one 75-slide batch through every place the old cap
// was enforced — adding files, a project file's import — and every place a
// big batch has to hold up: Describe all (still three requests at a time),
// saving and reopening a project, a project file out and back in, and the
// Studio zip.
import fs from "node:fs";
import { launch, makeImage, openWorkspace, outDir } from "./fixtures.mjs";

const OUT = outDir();
const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const API = "https://api.anthropic.com/v1/messages";
const COUNT = 75;

function unzipStore(buf) {
  const files = {}; let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const size = buf.readUInt32LE(off + 18), n = buf.readUInt16LE(off + 26), e = buf.readUInt16LE(off + 28);
    files[buf.toString("utf8", off + 30, off + 30 + n)] = buf.subarray(off + 30 + n + e, off + 30 + n + e + size);
    off += 30 + n + e + size;
  }
  return files;
}

const { b, page, problems } = await launch({ acceptDownloads: true });
// The zip export (B5) fetches each block's /static/<name> <img> and gets a
// 404 — the known quirk explained in regress15. Recorded by path so that
// only those are excused.
const notFound = [];
page.on("response", (r) => { if (r.status() === 404) notFound.push(new URL(r.url()).pathname); });
await openWorkspace(page);

// Each request answers after a short wait, so overlapping requests can be
// counted: the batch may be bigger, but it must not ask more of the API.
let inFlight = 0;
let maxInFlight = 0;
let requests = 0;
await page.route(API, async (route) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  requests += 1;
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  const n = requests;
  await new Promise((r) => setTimeout(r, 40));
  inFlight -= 1;
  return route.fulfill({
    status: 200,
    headers: { ...cors, "content-type": "application/json" },
    body: JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: `<h2>Visual ${n}</h2><p>Summary ${n}.</p>` }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
  });
});
await page.click("#settingsChip");
await page.fill("#apiKey", "sk-ant-test-key");
await page.click("#settingsDone");

// ---------- B1: 75 images, added in two drops (40, then 35)
const names = Array.from({ length: COUNT }, (_, i) => `Lecture_${String(i + 1).padStart(2, "0")}.png`);
const fileFor = async (name) => ({ name, mimeType: "image/png", buffer: await makeImage(page, { w: 480, h: 270, label: name }) });
const first = [];
for (const name of names.slice(0, 40)) first.push(await fileFor(name));
await page.setInputFiles("#fileInput", first);
await page.waitForFunction(() => document.querySelectorAll("#railList li").length === 40, null, { timeout: 30000 });
const second = [];
for (const name of names.slice(40)) second.push(await fileFor(name));
await page.setInputFiles("#railFileInput", second);
const allIn = await page
  .waitForFunction((n) => document.querySelectorAll("#railList li").length === n, COUNT, { timeout: 30000 })
  .then(() => true, () => false);
const rows = await page.$$eval("#railList li", (l) => l.length);
const errorLine = await page.$eval("#errorMessage", (e) => (e.hidden ? "" : e.textContent.trim()));
check(`B1  all ${COUNT} images are in the batch`, allIn, `${rows} rows`);
check("B1  nothing was refused for room", !/capped|maximum|full/i.test(errorLine), errorLine);

// ---------- B2: Describe all — every slide, still three at a time
await page.waitForFunction(() => !document.getElementById("describeBtn").disabled, null, { timeout: 30000 });
await page.click("#describeBtn");
const done = await page
  .waitForFunction((n) => [...jobs.values()].filter((j) => j.state === "done").length === n, COUNT, { timeout: 120000 })
  .then(() => true, () => false);
check(`B2  Describe all describes all ${COUNT}`, done, `${requests} requests`);
check(`B2  one request per slide`, requests === COUNT, `${requests}`);
check("B2  never more than three at once", maxInFlight <= 3, `max in flight ${maxInFlight}`);

await page.evaluate(() => { for (const j of jobs.values()) j.approved = true; renderAll(); });

// ---------- B3: saved as a project and reopened, all 75 come back
await page.fill("#batchName", "Long lecture");
await page.click("#projectsBtn");
await page.click("#saveProjectBtn");
await page.waitForSelector('#projectList button[aria-label="Open project Long lecture"]', { timeout: 30000 });
await page.evaluate(() => { jobs.clear(); renderAll(); });
await page.click('#projectList button[aria-label="Open project Long lecture"]');
const reopened = await page
  .waitForFunction((n) => document.querySelectorAll("#railList li").length === n, COUNT, { timeout: 30000 })
  .then(() => true, () => false);
check(`B3  a saved ${COUNT}-slide project reopens whole`, reopened);

// ---------- B4: a project file of 75 goes out and comes back in
let projectFile = null;
{
  if (!(await page.$eval("#projectsDialog", (d) => d.open))) await page.click("#projectsBtn");
  const dl = page.waitForEvent("download", { timeout: 30000 }).catch(() => null);
  await page.click('#projectList button[aria-label="Export project Long lecture"]');
  const d = await dl;
  if (d) { projectFile = `${OUT}/long-lecture.describeme.json`; await d.saveAs(projectFile); }
}
const parsed = projectFile ? JSON.parse(fs.readFileSync(projectFile, "utf8")) : null;
check(`B4  the exported project file holds all ${COUNT}`, parsed && parsed.jobs.length === COUNT, parsed ? `${parsed.jobs.length}` : "no download");
if (parsed) {
  parsed.name = "Long lecture again";
  await page.setInputFiles("#importProjectInput", [{ name: "again.describeme.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(parsed)) }]);
  const listed = await page
    .waitForSelector('#projectList button[aria-label="Open project Long lecture again"]', { timeout: 30000 })
    .then(() => true, () => false);
  const importError = await page.$eval("#projectsError", (e) => (e.hidden ? "" : e.textContent.trim()));
  check(`B4  and imports back in — no cap on the way in`, listed && !importError, importError);
}
if (await page.$eval("#projectsDialog", (d) => d.open)) await page.click("#projectsClose");

// ---------- B5: the Studio zip carries every visual
{
  const dl = page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
  await page.click("#exportBtn");
  const d = await dl;
  let files = {};
  if (d) { const p = `${OUT}/long-lecture.zip`; await d.saveAs(p); files = unzipStore(fs.readFileSync(p)); }
  const html = files["description.html"] ? files["description.html"].toString() : "";
  const images = Object.keys(files).filter((f) => f.startsWith("static/")).length;
  check(`B5  the zip has ${COUNT} images`, images === COUNT, `${images}`);
  check(`B5  and ${COUNT} counted visuals in its HTML`, html.includes(`Visual ${COUNT} of ${COUNT}: `) && (html.match(/<img src="\/static\//g) || []).length === COUNT);
}

check("Z  the only 404s are the export's detached /static/ <img> fetches",
  notFound.every((u) => u.startsWith("/static/")), notFound.filter((u) => !u.startsWith("/static/")).join(", "));
const realProblems = problems.filter((m) => !/status of 404/.test(m));
check("Z  no other console errors or CSP violations", realProblems.length === 0, realProblems.join(" | "));

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
