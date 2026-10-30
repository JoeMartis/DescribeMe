// Regression checks for the "fix first" set.
import fs from "node:fs";
import { launch, makeImage, openWorkspace, outDir } from "./fixtures.mjs";

const OUT = outDir();
const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const API = "https://api.anthropic.com/v1/messages";
const msg = (text) => ({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
async function routeApi(page, delays) {
  let n = 0;
  await page.route(API, async (route) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const d = delays[Math.min(n, delays.length - 1)]; n += 1;
    if (d) await new Promise((r) => setTimeout(r, d));
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(msg("<h2>T</h2><p>s</p>")) });
  });
}
async function setKey(page) { await page.click("#settingsChip"); await page.fill("#apiKey", "sk-ant-test-key"); await page.click("#settingsDone"); }
async function addImages(page, names) {
  const files = [];
  for (const name of names) files.push({ name, mimeType: "image/png", buffer: await makeImage(page, { w: 400, h: 225, label: name }) });
  const before = await page.$$eval("#railList li", (l) => l.length);
  await page.setInputFiles(before === 0 ? "#fileInput" : "#railFileInput", files);
  await page.waitForFunction((n) => document.querySelectorAll("#railList li").length === n, before + names.length);
  await page.waitForFunction(() => !document.getElementById("describeBtn").disabled, null, { timeout: 5000 }).catch(() => {});
}
function unzipStore(buf) {
  const files = {}; let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const size = buf.readUInt32LE(off + 18), n = buf.readUInt16LE(off + 26), e = buf.readUInt16LE(off + 28);
    files[buf.toString("utf8", off + 30, off + 30 + n)] = buf.subarray(off + 30 + n + e, off + 30 + n + e + size);
    off += 30 + n + e + size;
  }
  return files;
}
function dims(buf) {
  if (buf.readUInt32BE(0) === 0x89504e47) return { fmt: "png", w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) { let i = 2; while (i < buf.length) { if (buf[i] !== 0xff) { i++; continue; } const m = buf[i + 1]; if (m === 0xc0 || m === 0xc2) return { fmt: "jpeg", h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }; i += 2 + buf.readUInt16BE(i + 2); } }
  return { fmt: "?" };
}
const project = (name, jobs) => ({ format: "describeme-project", version: 1, name, savedAt: new Date().toISOString(), jobs });
async function importAndOpen(page, name, jobs, expectRows) {
  await page.click("#projectsBtn");
  await page.setInputFiles("#importProjectInput", [{ name: `${name}.describeme.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(project(name, jobs))) }]);
  await page.waitForSelector(`#projectList button[aria-label="Open project ${name}"]`);
  await page.click(`#projectList button[aria-label="Open project ${name}"]`);
  // Wait for THIS project to be the open one — a row count alone is already
  // satisfied by whatever batch was open before.
  await page.waitForFunction((n) => document.getElementById("batchName").value === n, name);
  await page.waitForFunction((c) => document.querySelectorAll("#railList li").length === c, expectRows);
  if (await page.$eval("#projectsDialog", (d) => d.open)) await page.click("#projectsClose");
}
async function setResize(page, on) { await page.click("#settingsChip"); if ((await page.$eval("#exportResize", (c) => c.checked)) !== on) await page.click("#exportResize"); await page.click("#settingsClose"); }
async function tryExport(page, label) {
  const dl = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
  await page.click("#exportBtn");
  const d = await dl;
  const status = await page.$eval("#statusMessage", (e) => e.textContent.trim());
  const error = await page.$eval("#errorMessage", (e) => (e.hidden ? "" : e.textContent.trim()));
  if (!d) return { zip: null, status, error };
  const p = `${OUT}/${label}.zip`; await d.saveAs(p);
  return { zip: unzipStore(fs.readFileSync(p)), status, error };
}

// ---------- A1: a description that landed mid-batch survives a reload
{
  const { b, page, problems } = await launch();
  await openWorkspace(page); await setKey(page);
  await routeApi(page, [0, 8000]); // slide 1 returns at once, slide 2 is still in flight when we reload
  await addImages(page, ["one.png", "two.png"]);
  await page.click("#describeBtn");
  await page.waitForFunction(() => document.querySelector(".js-approve-bar") && !document.querySelector(".js-approve-bar").hidden, null, { timeout: 8000 });
  const midBatch = await page.evaluate(() => !document.getElementById("progressCard").hidden);
  await page.waitForTimeout(2200); // past the 1.5 s autosave debounce, batch still running
  await page.reload({ waitUntil: "load" });
  if (!(await page.$eval("#onboarding", (o) => o.hidden))) await page.click("#onboardSkip");
  await page.waitForFunction(() => /Restored your last session/.test(document.getElementById("statusMessage").textContent), null, { timeout: 8000 }).catch(() => {});
  const after = await page.evaluate(() => ({
    rows: document.querySelectorAll("#railList li").length,
    firstDone: !!document.querySelector(".js-approve-bar") && !document.querySelector(".js-approve-bar").hidden,
    status: document.getElementById("statusMessage").textContent.trim(),
  }));
  check("A1  batch was still running when the page reloaded", midBatch);
  check("A1  the finished slide came back described after reload", after.rows === 2 && after.firstDone, `rows=${after.rows} firstDone=${after.firstDone} "${after.status}"`);
  check("A1  no page errors", problems.length === 0, problems.join(" | "));
  await b.close();
}

// ---------- A2: originals survive import; export is honest either way
{
  const { b, page, problems } = await launch({ acceptDownloads: true });
  await openWorkspace(page);
  const big = await makeImage(page, { w: 1600, h: 900, label: "ORIGINAL", type: "image/png" });
  const small = await makeImage(page, { w: 400, h: 225, label: "preview", type: "image/jpeg" });
  const base = { state: "done", approved: true, history: [], resultHtml: "<h2>A</h2><p>s</p>", resultText: "A s", dataUrl: `data:image/jpeg;base64,${small.toString("base64")}`, mediaType: "image/jpeg", width: 400, height: 225, resized: true, originalWidth: 1600, originalHeight: 900 };
  await importAndOpen(page, "With originals", [{ ...base, name: "Slide 1.png", originalBase64: big.toString("base64"), originalMediaType: "image/png" }], 1);
  await setResize(page, false);
  let r = await tryExport(page, "a2-with");
  const entry = r.zip && Object.keys(r.zip).find((k) => k.startsWith("static/"));
  const d = entry && dims(r.zip[entry]);
  check("A2a import keeps the original: export is the 1600×900 PNG", !!d && d.fmt === "png" && d.w === 1600 && d.h === 900 && entry === "static/Slide_1.png", `${entry} ${JSON.stringify(d)}`);
  check("A2a status says full resolution with no caveat", /full resolution/.test(r.status) && !/no original/.test(r.status), r.status);

  await importAndOpen(page, "Without originals", [{ ...base, name: "Slide 1.png" }], 1);
  r = await tryExport(page, "a2-without");
  const entry2 = r.zip && Object.keys(r.zip).find((k) => k.startsWith("static/"));
  const d2 = entry2 && dims(r.zip[entry2]);
  check("A2b no original: name follows the bytes (.jpg, JPEG)", !!d2 && d2.fmt === "jpeg" && entry2 === "static/Slide_1.jpg", `${entry2} ${JSON.stringify(d2)}`);
  check("A2b status admits the API copy was exported", /no original/.test(r.status) && !/full resolution/.test(r.status), r.status);
  check("A2  no page errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
  await b.close();
}

// ---------- A3: a slide with no image data is invalid, unapproved, and export still works
{
  const { b, page, problems } = await launch({ acceptDownloads: true });
  await openWorkspace(page);
  const small = await makeImage(page, { w: 400, h: 225, label: "p", type: "image/jpeg" });
  const good = { name: "ok.png", state: "done", approved: true, history: [], resultHtml: "<h2>A</h2><p>s</p>", resultText: "A s", dataUrl: `data:image/jpeg;base64,${small.toString("base64")}`, mediaType: "image/jpeg", width: 400, height: 225 };
  const broken = { ...good, name: "broken.png", dataUrl: undefined };
  await importAndOpen(page, "Broken", [good, broken], 2);
  const st = await page.evaluate(() => ({
    statuses: [...document.querySelectorAll("#railList .rail-status")].map((e) => e.textContent.trim()),
    exportLabel: document.getElementById("exportBtnLabel").textContent.trim(),
    describeCard: document.getElementById("describeCardBody").textContent.trim(),
  }));
  check("A3a the imageless slide is marked invalid, not Approved", st.statuses[1] !== "Approved" && /couldn.t prepare|invalid/i.test(st.statuses[1]), st.statuses.join(" | "));
  check("A3a only the real slide counts as approved", /Export 1 approved/.test(st.exportLabel), st.exportLabel);
  const r = await tryExport(page, "a3");
  check("A3b export downloads with the one good image and no error", !!r.zip && Object.keys(r.zip).filter((k) => k.startsWith("static/")).length === 1 && r.error === "", `error="${r.error}" status="${r.status}"`);
  check("A3  no page errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
  await b.close();
}

// ---------- A4: Tabbing onto the dropzone's file input shows a focus ring
{
  const { b, page, problems } = await launch();
  await openWorkspace(page);
  let reached = false;
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => document.activeElement && document.activeElement.id === "fileInput")) { reached = true; break; }
  }
  const ring = await page.evaluate(() => { const s = getComputedStyle(document.getElementById("dropZone")); return { style: s.outlineStyle, width: s.outlineWidth }; });
  check("A4  Tab reaches the dropzone file input", reached);
  check("A4  and the dropzone shows a visible outline", ring.style !== "none" && parseFloat(ring.width) >= 2, JSON.stringify(ring));
  check("A4  no page errors", problems.length === 0, problems.join(" | "));
  await b.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
