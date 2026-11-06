// A folder of segments at once: picked or dropped, sorted into segments by
// name, shown in the rail under a heading per segment that folds, reviewed
// segment by segment, and exported in one zip with a folder per segment.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, makeImage, openWorkspace, outDir } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };
const OUT = outDir();

async function until(page, fn, arg, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
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

const API = "https://api.anthropic.com/v1/messages";
const { b, page, problems } = await launch({ acceptDownloads: true });
await page.route(API, async (route) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  return route.fulfill({
    status: 200,
    headers: { ...cors, "content-type": "application/json" },
    body: JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "<h2>A chart</h2><p>Described.</p>" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
  });
});
await openWorkspace(page);

// A module folder on disk: two segments in folders of their own, their
// transcripts beside them, the odd file a folder collects, and a segment of
// a deck with no timestamps in its names.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "describeme-folder-"));
const dir = path.join(root, "UCE3");
for (const d of ["Cronin_S4", "Atalay_S2", "Deck", "Notes"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
let n = 0;
const write = async (rel) => { n += 1; fs.writeFileSync(path.join(dir, rel), await makeImage(page, { w: 320, h: 180, label: `img ${n}` })); };
// Written out of order: the folder has to put them in order itself.
await write("Cronin_S4/Cronin_S4_00-08-30.png");
await write("Cronin_S4/Cronin_S4_00-06-29.png");
await write("Cronin_S4/Cronin_S4_00-07-02.png");
await write("Atalay_S2/Atalay_S2_00-01-10.png");
await write("Atalay_S2/Atalay_S2_00-00-05.png");
await write("Deck/Slide2.png");
await write("Deck/Slide1.png");
// A second folder with no timestamps: a segment of its own, not Deck's.
await write("Notes/Board1.png");
const srt = (text) => `1\n00:00:00,000 --> 00:20:00,000\n${text}\n`;
fs.writeFileSync(path.join(dir, "Cronin_S4/Cronin_S4.srt"), srt("climate feedbacks across models"));
fs.writeFileSync(path.join(dir, "Atalay_S2/Atalay_S2.srt"), srt("semiconductor yield"));
fs.writeFileSync(path.join(dir, ".DS_Store"), "junk");
fs.writeFileSync(path.join(dir, "Cronin_S4/recording-notes.txt"), "not a slide");

// ---------- F1: a folder picked whole
await page.setInputFiles("#folderInput", dir);
await page.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length === 8, null, { timeout: 15000 });
const order = await page.evaluate(() => [...jobs.values()].map((j) => j.name));
check("F1  every slide in the folder is in, and nothing else",
  order.length === 8 && !order.some((x) => /DS_Store|\.txt|\.srt/.test(x)), JSON.stringify(order));
check("F1  sorted into segments, each in time order",
  order.join() === "Atalay_S2_00-00-05.png,Atalay_S2_00-01-10.png,Cronin_S4_00-06-29.png,Cronin_S4_00-07-02.png,Cronin_S4_00-08-30.png,Slide1.png,Slide2.png,Board1.png",
  order.join());
const left = await page.$eval("#statusMessage", (e) => e.textContent);
check("F1  the files left out are counted", /2 files in the folder are not a slide image or a transcript/.test(left), left);
const paired = await page.evaluate(() => [...jobs.values()].map((j) => !!j.transcriptContext));
check("F1  each segment's transcript pairs with its slides", paired.join() === "true,true,true,true,true,false,false,false", paired.join());
const segs = await page.evaluate(() => [...jobs.values()].map((j) => segmentLabel(j)));
check("F1  slides with no timestamp take their folder as their segment", segs.slice(5).join() === "Deck,Deck,Notes", segs.join());

// ---------- F2: a heading per segment, folding
const heads = () => page.evaluate(() => [...document.querySelectorAll("#railList .rail-segment-toggle")].map((b) => ({ text: b.textContent, open: b.getAttribute("aria-expanded") })));
const h = await heads();
const headNames = await page.evaluate(() => [...document.querySelectorAll("#railList .rail-segment-name")].map((e) => e.textContent));
check("F2  one heading per segment, in rail order", headNames.join() === "Atalay_S2,Cronin_S4,Deck,Notes", headNames.join());
check("F2  each says how many slides and how many approved", /3 slides · 0 approved/.test(h[1].text), h[1].text);
await page.click("#railList .rail-segment:nth-of-type(1) ~ .rail-segment .rail-segment-toggle >> nth=0");
const folded = await page.evaluate(() => ({
  open: document.querySelectorAll("#railList .rail-segment-toggle")[1].getAttribute("aria-expanded"),
  hidden: [...jobs.values()].filter((j) => j.railEl.closest("li").hidden).map((j) => j.name),
}));
check("F2  a heading folds its segment shut", folded.open === "false" && folded.hidden.join() === "Cronin_S4_00-06-29.png,Cronin_S4_00-07-02.png,Cronin_S4_00-08-30.png", JSON.stringify(folded));
await page.evaluate(() => selectJob([...jobs.values()][3].id));
const reopened = await page.evaluate(() => document.querySelectorAll("#railList .rail-segment-toggle")[1].getAttribute("aria-expanded"));
check("F2  choosing a slide in a folded segment opens it", reopened === "true");
const kicker = await page.evaluate(() => document.querySelector(".js-kicker").textContent);
check("F2  the pane gives the slide's place in its segment", /^Cronin_S4 · Slide 2 of 3 · Cronin_S4_00-07-02\.png$/.test(kicker), kicker);

// ---------- F3: a slide moves within its segment only
const moves = await page.evaluate(() => [...jobs.values()].map((j) => {
  const li = j.railEl.closest("li");
  return `${li.querySelector(".js-move-up").disabled ? "-" : "u"}${li.querySelector(".js-move-down").disabled ? "-" : "d"}`;
}));
check("F3  the move buttons stop at a segment's ends", moves.join() === "-d,u-,-d,ud,u-,-d,u-,--", moves.join());
await page.evaluate(() => moveJobTo([...jobs.values()][2].id, 0)); // Cronin's first, dragged above Atalay
const after = await page.evaluate(() => [...jobs.values()].map((j) => j.name));
check("F3  a slide dragged above another segment stays in its own", after.slice(0, 2).every((x) => x.startsWith("Atalay")) && after[2] === "Cronin_S4_00-06-29.png", after.join());

// ---------- F4: one Describe all for every segment, and Export all
await page.click("#settingsChip");
await page.fill("#apiKey", "sk-ant-test-key");
await page.click("#settingsDone");
await page.click("#describeBtn");
await until(page, () => [...jobs.values()].every((j) => j.state === "done"), null, 20000);
await page.evaluate(() => { jobs.forEach((j) => { j.approved = true; }); renderAll(); });
const label = await page.$eval("#exportBtn", (e) => e.textContent.trim());
check("F4  the export button says it exports all", /^Export all 8 approved as \.zip$/.test(label), label);
const dl = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
await page.click("#exportBtn");
const d = await dl;
let zip = {};
if (d) { const p = `${OUT}/export-all.zip`; await d.saveAs(p); zip = unzipStore(fs.readFileSync(p)); }
const names = Object.keys(zip).sort();
check("F4  one zip, a folder per segment, each with its description and images",
  ["Atalay_S2/description.html", "Cronin_S4/description.html", "Deck/description.html", "Notes/description.html"].every((x) => names.includes(x)) &&
    names.filter((x) => /^Cronin_S4\/static\//.test(x)).length === 3 && names.filter((x) => /^Deck\/static\//.test(x)).length === 2,
  names.join(" "));
const cronin = zip["Cronin_S4/description.html"] ? zip["Cronin_S4/description.html"].toString() : "";
check("F4  a segment's visuals are numbered within it", /3 visuals/.test(cronin) && /Visual 3 of 3/.test(cronin) && !/of 8/.test(cronin), cronin.slice(0, 120));
const imageNames = names.filter((x) => /\/static\//.test(x)).map((x) => x.split("/").pop());
check("F4  image names are unique across the whole export", new Set(imageNames).size === imageNames.length && imageNames.length === 8);
check("F4  the page says it made a folder per segment", /One folder for each of the 4 segments/.test(await page.$eval("#statusMessage", (e) => e.textContent)));

// ---------- F5: a dropped folder, read entry by entry
const dropped = await page.evaluate(async () => {
  const fileEntry = (name, fullPath) => ({
    isFile: true, isDirectory: false, name, fullPath,
    file: (ok) => ok(new File([new Uint8Array([1])], name, { type: name.endsWith(".png") ? "image/png" : "" })),
  });
  // A folder whose reader gives its entries in two batches, as Chrome does past 100.
  const dirEntry = (name, fullPath, children) => {
    const batches = [children.slice(0, 1), children.slice(1), []];
    return { isFile: false, isDirectory: true, name, fullPath, createReader: () => ({ readEntries: (ok) => ok(batches.shift() || []) }) };
  };
  const tree = dirEntry("Seg", "/Mod/Seg", [fileEntry("Seg_00-00-02.png", "/Mod/Seg/Seg_00-00-02.png"), fileEntry("Seg_00-00-01.png", "/Mod/Seg/Seg_00-00-01.png")]);
  const files = await filesFromEntries([tree]);
  return { names: files.map((f) => f.name), folders: files.map((f) => folderOfFile(f)) };
});
check("F5  a dropped folder is read to the end, across reader batches", dropped.names.length === 2 && dropped.folders.every((f) => f === "Seg"), JSON.stringify(dropped));

// ---------- F6: a reload keeps the segments
await page.evaluate(() => writeAutosave());
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => typeof jobs !== "undefined" && jobs.size === 8, null, { timeout: 15000 });
const kept = await page.evaluate(() => [...document.querySelectorAll("#railList .rail-segment-name")].map((e) => e.textContent));
check("F6  after a reload the segments are as they were", kept.join() === "Atalay_S2,Cronin_S4,Deck,Notes", kept.join());

check("Z  no console errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
fs.rmSync(root, { recursive: true, force: true });
await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
