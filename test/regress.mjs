// Regression checks for the "worth fixing" set. Each test gets a fresh page;
// the Anthropic endpoint is intercepted so no key or network is needed.
import fs from "node:fs";
import { launch, makeImage, makeVideo, openWorkspace, outDir } from "./fixtures.mjs";

const OUT = outDir();
const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const API = "https://api.anthropic.com/v1/messages";
function routeApi(page, state) {
  return page.route(API, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    const body = state.next();
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
  });
}
const msg = (text, stop_reason = "end_turn") => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5",
  content: text === null ? [] : [{ type: "text", text }], stop_reason, usage: { input_tokens: 10, output_tokens: 10 },
});
async function setKey(page) {
  await page.click("#settingsChip");
  await page.fill("#apiKey", "sk-ant-test-key");
  await page.click("#settingsDone");
}
async function addImages(page, names) {
  const files = [];
  for (const name of names) files.push({ name, mimeType: "image/png", buffer: await makeImage(page, { w: 400, h: 225, label: name }) });
  const before = await page.$$eval("#railList li", (l) => l.length);
  await page.setInputFiles(before === 0 ? "#fileInput" : "#railFileInput", files);
  await page.waitForFunction((n) => document.querySelectorAll("#railList li").length === n, before + names.length);
  await page.waitForFunction(() => !document.getElementById("describeBtn").disabled, null, { timeout: 5000 }).catch(() => {});
}
async function loadVideoAndSeek(page, vid, seconds) {
  await page.setInputFiles("#videoInput", [{ name: "Lecture_3.webm", mimeType: "video/webm", buffer: vid }]);
  await page.waitForFunction(() => !document.getElementById("videoStage").hidden);
  await page.evaluate((s) => new Promise((r) => { const v = document.getElementById("videoEl"); v.addEventListener("seeked", () => r(), { once: true }); v.currentTime = s; }), seconds);
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

// ---------- N1: stop_reason max_tokens → warning; refusal → specific error, no key blame
{
  const { b, page, problems } = await launch();
  await openWorkspace(page); await setKey(page);
  const queue = [msg("<h2>T</h2><p>Summary.</p><p>Then <math><mrow><mi>a</mi>", "max_tokens")];
  await routeApi(page, { next: () => queue.shift() });
  await addImages(page, ["one.png"]);
  await page.click("#describeBtn");
  await page.waitForFunction(() => document.querySelector(".js-math-warning") && !document.querySelector(".js-math-warning").hidden, null, { timeout: 8000 }).catch(() => {});
  const warn = await page.$eval(".js-math-warning", (e) => (e.hidden ? "" : e.textContent));
  check("N1a max_tokens lands as done WITH a cut-off warning", /cut off/i.test(warn), warn.slice(0, 80));

  queue.push(msg(null, "refusal"));
  await addImages(page, ["two.png"]); // now 2 rows; describe the new one
  await page.click("#describeBtn");
  await page.waitForFunction(() => [...document.querySelectorAll("#railList .rail-status")].some((s) => /fail|error|didn/i.test(s.textContent)), null, { timeout: 8000 }).catch(() => {});
  // select the failed one
  await page.evaluate(() => { const rows = [...document.querySelectorAll("#railList .rail-row")]; rows[rows.length - 1].click(); });
  const pend = await page.evaluate(() => ({ body: document.querySelector(".js-pending-body")?.textContent || "", detail: document.querySelector(".js-pending-detail")?.textContent || "" }));
  check("N1b refusal explains itself and does not blame the key", /declined/i.test(pend.body) && !/API key/i.test(pend.body) && /refusal/i.test(pend.detail), pend.body.slice(0, 80));
  check("N1  no page errors", problems.length === 0, problems.join(" | "));
  await b.close();
}

// ---------- P4: undo restores state; approve → undo un-approves; truncation warning comes back
{
  const { b, page, problems } = await launch();
  await openWorkspace(page); await setKey(page);
  const queue = [msg("<h2>T</h2><p>Summary.</p><p>Then <math><mrow><mi>a</mi>", "max_tokens")];
  await routeApi(page, { next: () => queue.shift() });
  await addImages(page, ["one.png"]);
  await page.click("#describeBtn");
  await page.waitForFunction(() => document.querySelector(".js-approve") && !document.querySelector(".js-approve-bar").hidden, null, { timeout: 8000 });
  await page.click(".js-approve");
  await page.evaluate(() => document.querySelectorAll("#railList .rail-row")[0].click()); // back to the (now approved) slide
  const approvedBefore = await page.$eval(".js-approve-label", (e) => e.textContent.trim());
  // edit the source to a complete description
  await page.click(".js-source summary");
  await page.click(".js-edit-source");
  await page.fill(".js-source-code", "<h2>T</h2><p>Summary.</p><p>Then a equals b.</p>");
  await page.click(".js-edit-source"); // save
  const afterEdit = await page.evaluate(() => ({ warn: document.querySelector(".js-math-warning").hidden, meta: document.querySelector(".js-desc-meta").textContent }));
  await page.click(".js-undo");
  const afterUndo = await page.evaluate(() => ({ warnText: document.querySelector(".js-math-warning").hidden ? "" : document.querySelector(".js-math-warning").textContent, meta: document.querySelector(".js-desc-meta").textContent, approve: document.querySelector(".js-approve-label").textContent.trim() }));
  check("P4a edit cleared the cut-off warning, undo brought it back", afterEdit.warn === true && /cut off/i.test(afterUndo.warnText));
  check("P4b undo drops the 'edited' marker", /edited/i.test(afterEdit.meta) && !/edited/i.test(afterUndo.meta), `before: "${afterEdit.meta}" after: "${afterUndo.meta}"`);
  check("P4c undo after approve leaves the slide needing review", approvedBefore === "Un-approve" && afterUndo.approve === "Approve & next", `${approvedBefore} → ${afterUndo.approve}`);
  check("P4  no page errors", problems.length === 0, problems.join(" | "));
  await b.close();
}

// ---------- V1: the same second is refused across dialog sessions
{
  const { b, page, problems } = await launch();
  await openWorkspace(page);
  const vid = await makeVideo(page, { seconds: 4 });
  await page.click("#videoBtn"); await loadVideoAndSeek(page, vid, 2);
  await page.click("#videoCapture");
  await page.waitForFunction(() => document.querySelectorAll("#railList li").length === 1);
  await page.click("#videoClose");
  await page.click("#videoBtn"); await loadVideoAndSeek(page, vid, 2);
  await page.click("#videoCapture");
  await page.waitForTimeout(600);
  const rows = await page.$$eval("#railList li", (l) => l.length);
  const err = await page.$eval("#videoError", (e) => (e.hidden ? "" : e.textContent));
  check("V1  re-capturing 0:02 after reopening the dialog is refused", rows === 1 && /already in the batch/i.test(err), `rows=${rows} "${err}"`);
  check("V1  no page errors", problems.length === 0, problems.join(" | "));
  await b.close();
}

// ---------- E2/E3: export names are URL-safe and path-free, and src matches
{
  const { b, page, problems } = await launch({ acceptDownloads: true });
  const notFound = [];
  page.on("response", (r) => { if (r.status() === 404) notFound.push(new URL(r.url()).pathname); });
  await openWorkspace(page);
  const jpg = await makeImage(page, { w: 400, h: 225, label: "p", type: "image/jpeg" });
  const mk = (name) => ({ name, state: "done", approved: true, history: [], resultHtml: "<h2>A</h2><p>s</p>", resultText: "A s", dataUrl: `data:image/jpeg;base64,${jpg.toString("base64")}`, mediaType: "image/jpeg", width: 400, height: 225 });
  const file = { format: "describeme-project", version: 1, name: "Names", savedAt: new Date().toISOString(), jobs: [mk("Slide #3.png"), mk("../../evil.png"), mk("a b%?.PNG"), mk("Lecture_3_00-04-32.jpg")] };
  await page.click("#projectsBtn");
  await page.setInputFiles("#importProjectInput", [{ name: "n.describeme.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) }]);
  await page.waitForSelector('#projectList button[aria-label="Open project Names"]');
  await page.click('#projectList button[aria-label="Open project Names"]');
  await page.waitForFunction(() => document.querySelectorAll("#railList li").length === 4);
  if (await page.$eval("#projectsDialog", (d) => d.open)) await page.click("#projectsClose");
  const railNames = await page.$$eval("#railList .rail-name", (l) => l.map((e) => e.textContent.trim()));
  const dl = page.waitForEvent("download", { timeout: 6000 });
  await page.click("#exportBtn");
  const d = await dl; const p = `${OUT}/names.zip`; await d.saveAs(p);
  const z = unzipStore(fs.readFileSync(p));
  const entries = Object.keys(z).filter((n) => n.startsWith("static/")).sort();
  const srcs = [...z["description.html"].toString().matchAll(/src="([^"]+)"/g)].map((m) => m[1]).sort();
  // These imported slides carry no originals, so what gets exported is the JPEG
  // preview — and since the fix-first round, the name follows the bytes.
  const expected = ["static/Lecture_3_00-04-32.jpg", "static/Slide_3.jpg", "static/a_b.jpg", "static/evil.jpg"].sort();
  check("E3  imported '../../evil.png' is reduced to its basename in the rail", railNames.includes("evil.png"), railNames.join(", "));
  check("E2  zip entries are URL-safe, path-free, extension lowercased", JSON.stringify(entries) === JSON.stringify(expected), entries.join(", "));
  check("E2  every <img src> matches a zip entry exactly", JSON.stringify(srcs) === JSON.stringify(expected.map((e) => "/" + e)), srcs.join(", "));
  const onlyStatic404 = notFound.every((u) => u.startsWith("/static/")); // vacuously true when the detached fetches never fire
  const realProblems = problems.filter((m) => !/404/.test(m));
  check("E2  the only 404s are the detached /static/ <img> fetches (pre-existing quirk)", onlyStatic404, notFound.join(", "));
  check("E2  no other page errors", realProblems.length === 0, realProblems.join(" | "));
  await b.close();
}

// ---------- U4: Space on the Close button closes the dialog instead of toggling playback
{
  const { b, page, problems } = await launch();
  await openWorkspace(page);
  const vid = await makeVideo(page, { seconds: 3 });
  await page.click("#videoBtn"); await loadVideoAndSeek(page, vid, 1);
  await page.focus("#videoClose");
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  const open = await page.$eval("#videoDialog", (d) => d.open);
  check("U4  Space activates Close", open === false);
  // and Space still plays/pauses when focus is on the scrub bar
  await page.click("#videoBtn"); await loadVideoAndSeek(page, vid, 0);
  // The fixture WebM reports no duration, so the scrub bar is disabled and
  // cannot take focus; send Space from a non-control element in the dialog.
  await page.evaluate(() => document.getElementById("videoBox").dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })));
  await page.waitForTimeout(300);
  const playing = await page.$eval("#videoEl", (v) => !v.paused);
  check("U4  Space away from a control still plays", playing);
  check("U4  no page errors", problems.length === 0, problems.join(" | "));
  await b.close();
}

// ---------- U2: Enter on Describe all moves focus to Stop
{
  const { b, page, problems } = await launch();
  await openWorkspace(page); await setKey(page);
  await routeApi(page, { delayMs: 1500, next: () => msg("<h2>T</h2><p>s</p>") });
  await addImages(page, ["one.png"]);
  await page.focus("#describeBtn");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  const active = await page.evaluate(() => document.activeElement && document.activeElement.id);
  check("U2  focus lands on Stop, not <body>", active === "stopBtn", `activeElement=#${active}`);
  await page.waitForTimeout(2000);
  check("U2  no page errors", problems.length === 0, problems.join(" | "));
  await b.close();
}

// ---------- U3: closing the dialog after a first capture from the empty state keeps focus
{
  const { b, page, problems } = await launch();
  await openWorkspace(page);
  const vid = await makeVideo(page, { seconds: 3 });
  await page.focus("#videoBtnEmpty");
  await page.keyboard.press("Enter");
  await loadVideoAndSeek(page, vid, 1);
  await page.click("#videoCapture");
  await page.waitForFunction(() => document.querySelectorAll("#railList li").length === 1);
  await page.click("#videoClose");
  await page.waitForTimeout(200);
  const active = await page.evaluate(() => { const a = document.activeElement; return a === document.body ? "BODY" : (a.id || a.className); });
  check("U3  focus is on the captured slide's rail row, not <body>", /rail-row/.test(active), `activeElement=${active}`);
  check("U3  no page errors", problems.length === 0, problems.join(" | "));
  await b.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
