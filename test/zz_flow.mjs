import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { launch, makeImage, openWorkspace } from "./fixtures.mjs";
const API = "https://api.anthropic.com/v1/messages";
const { b, page, problems } = await launch({ acceptDownloads: true });
let n = 0;
await page.route(API, async (route) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const body = JSON.parse(route.request().postData());
  n += 1;
  const isChat = /DISCUSSING THE DESCRIPTION/.test(body.system);
  const text = isChat ? "Named it.\n<revision><h2>Revised Chart</h2><p>Chart, revised.</p></revision>" : `<h2>Chart ${n}</h2><p>Description ${n}.</p>`;
  return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } }) });
});
await openWorkspace(page);
await page.click("#settingsChip"); await page.fill("#apiKey", "sk-ant-test"); await page.click("#settingsDone");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-")); const dir = path.join(root, "Module 3");
fs.mkdirSync(path.join(dir, "S1"), { recursive: true }); fs.mkdirSync(path.join(dir, "S2"), { recursive: true });
const a = await makeImage(page, { w: 400, h: 225, label: "a" });
fs.writeFileSync(path.join(dir, "S1", "Lec_S1_00-00-01.png"), a);
fs.writeFileSync(path.join(dir, "S1", "Lec_S1_00-00-02.png"), a); // identical: Same as
fs.writeFileSync(path.join(dir, "S1", "Lec_S1_00-00-03.png"), await makeImage(page, { w: 400, h: 225, label: "c" }));
fs.writeFileSync(path.join(dir, "S2", "Lec_S2_00-00-05.png"), await makeImage(page, { w: 400, h: 225, label: "d" }));
fs.writeFileSync(path.join(dir, "S1", "Lec_S1.srt"), "1\n00:00:00,000 --> 00:10:00,000\nthe chart builds up\n");
await page.setInputFiles("#railFolderInput", dir);
await page.waitForFunction(() => jobs.size === 4 && [...jobs.values()].every((j) => j.base64), null, { timeout: 15000 });
await page.click("#describeBtn");
await page.waitForFunction(() => !batchRunning && [...jobs.values()].every((j) => j.state === "done"), null, { timeout: 20000 });
// discuss slide 3 and use the revision
await page.evaluate(() => { const c = [...jobs.values()][2]; selectJob(c.id); discussOpen = true; renderDetail(); });
await page.fill("#detailPane .js-discuss-input", "Name it better.");
await page.keyboard.press("Enter");
await page.waitForFunction(() => [...jobs.values()][2].discussion?.some((m) => m.revision));
await page.click("#detailPane .js-discuss-use");
await page.evaluate(() => { for (const j of jobs.values()) j.approved = true; renderAll(); });
const state = await page.evaluate(() => [...jobs.values()].map((j) => `${j.name} | seg=${segmentLabel(j)} | same=${!!j.sameAsPrevious} | ctx=${j.contextFrom ? (j.contextFrom.missing ? "missing" : "yes") : "none"} | flag=${previousStatus(j)} | ${j.resultText.slice(0, 40)}`));
console.log(state.join("\n"));
const dl = page.waitForEvent("download", { timeout: 10000 }).catch(() => null);
await page.click("#exportBtn");
const d = await dl;
if (d) {
  const p = path.join(root, "out.zip"); await d.saveAs(p);
  const buf = fs.readFileSync(p); const files = {}; let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) { const size = buf.readUInt32LE(off + 18), nn = buf.readUInt16LE(off + 26), e = buf.readUInt16LE(off + 28); files[buf.toString("utf8", off + 30, off + 30 + nn)] = buf.subarray(off + 30 + nn + e, off + 30 + nn + e + size); off += 30 + nn + e + size; }
  console.log("ZIP:", Object.keys(files).join(" "));
  for (const [k, v] of Object.entries(files)) if (k.endsWith(".html")) console.log(`--- ${k}\n` + v.toString().replace(/<img[^>]*>/g, "<img>").replace(/\s+/g, " ").slice(0, 700));
}
console.log("status:", await page.$eval("#statusMessage", (e) => e.textContent));
console.log("problems:", problems.filter((p) => !/404/.test(p)).join(" | "));
fs.rmSync(root, { recursive: true, force: true });
await b.close();
