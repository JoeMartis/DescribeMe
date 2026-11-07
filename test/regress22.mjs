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
// The .txt; a .DS_Store is a system file, left out without a word.
check("F1  the files left out are counted", /1 file in the folder is not a slide image or a transcript/.test(left), left);
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
check("F2  the pane gives the slide's place in its segment", kicker === "Slide 2 of 3 in Cronin_S4", kicker);

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
  nameFolders(files);
  return { names: files.map((f) => f.name), folders: files.map((f) => folderOfFile(f)) };
});
check("F5  a dropped folder is read to the end, across reader batches", dropped.names.length === 2 && dropped.folders.every((f) => f === "Seg"), JSON.stringify(dropped));

// ---------- F6: a reload keeps the segments
await page.evaluate(() => writeAutosave());
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => typeof jobs !== "undefined" && jobs.size === 8, null, { timeout: 15000 });
const kept = await page.evaluate(() => [...document.querySelectorAll("#railList .rail-segment-name")].map((e) => e.textContent));
check("F6  after a reload the segments are as they were", kept.join() === "Atalay_S2,Cronin_S4,Deck,Notes", kept.join());

// ---------- B: the bug round
// B4: the heading's accessible name keeps the segment's name apart.
const b4 = await page.evaluate(() => document.querySelectorAll("#railList .rail-segment-toggle")[1].textContent);
check("B4  the heading reads as name, then counts", /^Cronin_S4, 3 slides · /.test(b4), b4);

// B5: a Mac's files in a folder are left out without a word.
const mac = fs.mkdtempSync(path.join(os.tmpdir(), "describeme-mac-"));
fs.mkdirSync(path.join(mac, "Mac_S1"));
fs.mkdirSync(path.join(mac, "__MACOSX", "Mac_S1"), { recursive: true });
fs.writeFileSync(path.join(mac, "Mac_S1", "Mac_S1_00-00-01.png"), await makeImage(page, { w: 320, h: 180, label: "mac" }));
fs.writeFileSync(path.join(mac, "Mac_S1", "._Mac_S1_00-00-01.png"), "AppleDouble");
fs.writeFileSync(path.join(mac, "__MACOSX", "Mac_S1", "._Mac_S1_00-00-01.png"), "AppleDouble");
await page.setInputFiles("#railFolderInput", mac);
await page.waitForFunction(() => [...jobs.values()].some((j) => j.name === "Mac_S1_00-00-01.png"), null, { timeout: 10000 });
await page.waitForTimeout(500);
const b5 = await page.evaluate(() => ({ names: [...jobs.values()].filter((j) => /Mac_S1/.test(j.name)).map((j) => j.name), invalid: [...jobs.values()].filter((j) => j.state === "invalid").length }));
check("B5  macOS ._ files and __MACOSX are not slides", b5.names.join() === "Mac_S1_00-00-01.png" && b5.invalid === 0, JSON.stringify(b5));
fs.rmSync(mac, { recursive: true, force: true });

// B6: Export all only when the approved slides span segments.
const b6 = await page.evaluate(() => {
  jobs.forEach((j) => { j.approved = segmentLabel(j) === "Cronin_S4" && j.state === "done"; });
  renderAll();
  return document.getElementById("exportBtn").textContent.trim();
});
check("B6  approvals in one segment are not called Export all", b6 === "Export 3 approved as .zip", b6);

// B7: a description leaning on a visual left out of the export is named.
await page.evaluate(() => {
  const list = [...jobs.values()].filter((j) => segmentLabel(j) === "Cronin_S4");
  list[1].approved = false; // the one before list[2]
  list[2].sameAsPrevious = true;
  list[2].resultHtml = "<p>Same as the previous visual.</p>";
  renderAll();
});
const dl7 = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
await page.click("#exportBtn");
await dl7;
const b7 = await page.$eval("#statusMessage", (e) => e.textContent);
check("B7  the export names a description whose previous visual is not in it", /Cronin_S4_00-08-30\.png builds on the visual before it, which is not in the export/.test(b7), b7.slice(0, 200));

// B8: the learner download heads each segment and numbers within it.
const b8 = await page.evaluate(async () => {
  jobs.forEach((j) => { j.approved = j.state === "done"; j.sameAsPrevious = false; });
  const doc = await learnerDocument();
  return { h2: [...doc.html.matchAll(/<h2>([^<]+)/g)].map((m) => m[1].split(" — ")[0].trim()), separated: /<h2>Cronin_S4 — 3 visuals<\/h2>/.test(doc.html), restarts: (doc.html.match(/Visual 1 of/g) || []).length };
});
check("B8  the learner download has a heading per segment, numbered within each", b8.h2.slice(0, 2).join() === "Atalay_S2,Cronin_S4" && b8.restarts >= 3, JSON.stringify(b8));
check("B8  its segment heading reads name — count", b8.separated, JSON.stringify(b8));

// B9: an image's fingerprint is quick, whatever its size.
const b9 = await page.evaluate(() => {
  const big = { originalBase64: "A".repeat(20 * 1024 * 1024) + "B" };
  const t = performance.now();
  const fp = imageFingerprint(big);
  const other = imageFingerprint({ originalBase64: "A".repeat(20 * 1024 * 1024) + "C" });
  return { ms: performance.now() - t, differ: fp !== other };
});
check("B9  fingerprinting a 20 MB image is quick, and tells two apart", b9.ms < 300 && b9.differ, JSON.stringify(b9));

// ---------- H: the rail's header, option A
const h1 = await page.evaluate(() => ({
  count: document.getElementById("railCount").textContent,
  slides: jobs.size,
  moreShown: !document.getElementById("railMoreBtn").hidden,
}));
check("H1  the heading carries the slide count, and ⋯ is there with a batch", h1.count === String(h1.slides) && h1.moreShown, JSON.stringify(h1));
await page.click("#railAddBtn");
const h2 = await page.evaluate(() => ({
  open: !document.getElementById("railAddMenu").hidden,
  expanded: document.getElementById("railAddBtn").getAttribute("aria-expanded"),
  items: [...document.querySelectorAll("#railAddMenu .rail-menu-label")].map((e) => e.textContent),
  focus: document.activeElement && document.activeElement.id,
}));
check("H2  Add opens one menu for every way in, focus on its first item",
  h2.open && h2.expanded === "true" && h2.items.join() === "Slide images or transcripts,A folder of segments,Frames from a video" && h2.focus === "railFileInput", JSON.stringify(h2));
await page.keyboard.press("Escape");
const h3 = await page.evaluate(() => ({ open: !document.getElementById("railAddMenu").hidden, focus: document.activeElement.id }));
check("H3  Escape closes it and returns to Add", !h3.open && h3.focus === "railAddBtn", JSON.stringify(h3));
await page.click("#railAddBtn");
await page.click("#railHeading");
check("H3  a click elsewhere closes it", await page.evaluate(() => document.getElementById("railAddMenu").hidden));
await page.click("#railAddBtn");
await page.click("#railVideoItem");
const h4 = await page.evaluate(() => ({ dialog: document.getElementById("videoDialog") ? document.getElementById("videoDialog").open : null, menu: document.getElementById("railAddMenu").hidden }));
check("H4  Frames from a video opens the video dialog and closes the menu", h4.dialog === true && h4.menu, JSON.stringify(h4));
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
const h5 = await page.evaluate(() => {
  renderAll(); // B8 above set approvals directly, as the app never does
  const job = [...jobs.values()].find((j) => j.name === "Cronin_S4_00-06-29.png");
  const name = job.railEl.querySelector(".rail-name");
  const head = [...document.querySelectorAll("#railList .rail-segment-toggle")].find((b) => b.querySelector(".rail-segment-name").textContent === "Cronin_S4");
  const members = [...jobs.values()].filter((j) => segmentLabel(j) === "Cronin_S4");
  const approved = members.filter((j) => j.state === "done" && j.approved).length;
  return {
    shared: name.querySelector(".rail-name-shared")?.textContent,
    own: name.querySelector(".rail-name-own")?.textContent,
    whole: name.textContent,
    bar: head.querySelector(".rail-segment-bar > span").style.width,
    expected: `${Math.round((approved / members.length) * 100)}%`,
  };
});
check("H5  the whole file name shows, its segment's part quiet and its own plain",
  h5.whole === "Cronin_S4_00-06-29.png" && h5.shared === "Cronin_S4_" && h5.own === "00-06-29.png", JSON.stringify(h5));
check("H5  the segment's bar shows its share approved", h5.bar === h5.expected, JSON.stringify(h5));

// ---------- R: bug round 1
// R1: Escape with focus back on Add closes its menu; Tab past the last item does too.
await page.click("#railAddBtn");
await page.focus("#railAddBtn");
await page.keyboard.press("Escape");
check("R1  Escape on the Add button closes its menu", await page.evaluate(() => document.getElementById("railAddMenu").hidden));
await page.click("#railAddBtn");
for (let i = 0; i < 4; i += 1) await page.keyboard.press("Tab");
const r1 = await page.evaluate(() => ({ hidden: document.getElementById("railAddMenu").hidden, inMenu: !!document.activeElement.closest("#railAddMenu") }));
check("R1  Tabbing out of the menu closes it", r1.hidden && !r1.inMenu, JSON.stringify(r1));

// R2: a slide's row that is folded away hands focus to its segment's heading.
const r2 = await page.evaluate(() => {
  const job = [...jobs.values()].find((j) => j.name === "Cronin_S4_00-07-02.png");
  job.railEl.closest("li").querySelector(".js-move-up").focus();
  collapsedSegments.add(segmentKey(job));
  renderRail();
  const a = document.activeElement;
  const result = { isHeading: !!a.closest(".rail-segment"), text: a.textContent };
  collapsedSegments.delete(segmentKey(job));
  renderRail();
  return result;
});
check("R2  folding a segment moves focus from its row to its heading", r2.isHeading && /^Cronin_S4/.test(r2.text), JSON.stringify(r2));

// R3: only a description that builds on the slide before is named on export.
const r3 = await page.evaluate(() => {
  const list = [...jobs.values()].filter((j) => segmentLabel(j) === "Cronin_S4");
  const [a, b, c] = list;
  a.resultHtml = "<h2>Feedbacks across models</h2><p>A bar chart.</p>";
  b.resultHtml = "<h2>Feedbacks across models</h2><p>The same chart, now with the cloud bar highlighted.</p>";
  b.resultText = "Feedbacks across models The same chart"; b.sameAsPrevious = false;
  b.contextFrom = contextRecord(a, a.resultHtml);
  c.resultHtml = "<h2>Sea level rise</h2><p>A different line graph.</p>";
  c.resultText = "Sea level rise A different line graph."; c.sameAsPrevious = false;
  c.contextFrom = contextRecord(b, b.resultHtml);
  return { change: buildsOnPrevious(b), fresh: buildsOnPrevious(c) };
});
check("R3  a change to the same graph builds on the one before; a new visual does not", r3.change && !r3.fresh, JSON.stringify(r3));

// R4: a folder whose transcript cannot be read says so, after its images are in.
const bad = fs.mkdtempSync(path.join(os.tmpdir(), "describeme-bad-"));
fs.mkdirSync(path.join(bad, "Bad_S1"));
fs.writeFileSync(path.join(bad, "Bad_S1", "Bad_S1_00-00-01.png"), await makeImage(page, { w: 320, h: 180, label: "bad" }));
fs.writeFileSync(path.join(bad, "Bad_S1", "Bad_S1.srt"), "this is not a caption file");
await page.setInputFiles("#railFolderInput", bad);
await page.waitForFunction(() => [...jobs.values()].some((j) => j.name === "Bad_S1_00-00-01.png"), null, { timeout: 10000 });
await page.waitForTimeout(400);
const r4 = await page.evaluate(() => (document.getElementById("errorMessage").hidden ? "" : document.getElementById("errorMessage").textContent));
check("R4  a folder's unreadable transcript is reported, not wiped", /No captions found in "Bad_S1\.srt"/.test(r4), r4);
fs.rmSync(bad, { recursive: true, force: true });

// R5: with no slides, a render does not shut the Add menu.
await page.evaluate(() => { jobs.clear(); els.railList.replaceChildren(); selectedJobId = null; renderAll(); });
await page.click("#railAddBtn");
await page.evaluate(() => renderAll());
check("R5  a render with an empty batch leaves the Add menu open", await page.evaluate(() => !document.getElementById("railAddMenu").hidden));
await page.keyboard.press("Escape");

// ---------- T: bug round 3
// T1: folders of one name in different places are two segments; the folder
// brought in is not part of the name.
const t1 = await page.evaluate(() => {
  const named = (paths) => {
    const files = paths.map((p) => { const f = new File([new Uint8Array([1])], p.split("/").pop(), { type: "image/png" }); fileFolders.set(f, "/" + p); return f; });
    nameFolders(files);
    return files.map(folderOfFile);
  };
  return {
    twins: named(["Module/M1/Slides/a.png", "Module/M2/Slides/b.png"]),
    module: named(["UCE_M3/S2/a.png", "UCE_M3/S3/b.png"]),
    single: named(["Lecture/a.png", "Lecture/b.png"]),
  };
});
check("T1  two folders of one name are two segments", t1.twins.join() === "M1/Slides,M2/Slides", JSON.stringify(t1.twins));
check("T1  a module's folders are named below it, a lone folder for itself", t1.module.join() === "S2,S3" && t1.single.join() === "Lecture,Lecture", JSON.stringify(t1));

// T2/T3 on a segment of their own.
const tImg = async (label) => makeImage(page, { w: 320, h: 180, label });
const ta = await tImg("t round A"), tc = await tImg("t round C");
await page.setInputFiles("#railFileInput", [
  { name: "Tee_S1_00-00-01.png", mimeType: "image/png", buffer: ta },
  { name: "Tee_S1_00-00-02.png", mimeType: "image/png", buffer: ta },
  { name: "Tee_S1_00-00-03.png", mimeType: "image/png", buffer: tc },
]);
await page.waitForFunction(() => { const t = [...jobs.values()].filter((j) => j.name.startsWith("Tee_S1")); return t.length === 3 && t.every((j) => j.base64); });

// T2: a "Same as" whose original failed cannot go with the next slide, so
// the next is not flagged for going without it, until the original is done.
const t2 = await page.evaluate(() => {
  const [a, b, c] = [...jobs.values()].filter((j) => j.name.startsWith("Tee_S1"));
  a.state = "error"; a.resultHtml = ""; a.resultText = "";
  b.state = "done"; b.resultHtml = "<p>Same as the previous visual.</p>"; b.resultText = "Same as the previous visual."; b.sameAsPrevious = true;
  b.contextFrom = contextRecord(a, null);
  c.state = "done"; c.resultHtml = "<h2>C</h2>"; c.resultText = "C"; c.contextFrom = { image: imageFingerprint(b), html: null, missing: true };
  const before = previousStatus(c);
  a.state = "done"; a.resultHtml = "<h2>Tee</h2><p>A graph.</p>"; a.resultText = "Tee A graph.";
  return { before, after: previousStatus(c) };
});
check("T2  not flagged while the visual before cannot be sent with it", t2.before === null, JSON.stringify(t2));
check("T2  flagged once it can", t2.after === "missing", JSON.stringify(t2));

// T3: a "Same as" rewritten by hand is a description of its own.
const t3 = await page.evaluate(() => {
  const [, b, c] = [...jobs.values()].filter((j) => j.name.startsWith("Tee_S1"));
  selectJob(b.id);
  toggleEdit(b.id);
  els.detailPane.querySelector(".js-preview").innerHTML = "<h2>Tee</h2><p>The same graph, now with the peak circled.</p>";
  commitEdit();
  return { same: isSameAsPrevious(b), context: contextHtml(b), pane: els.detailPane.textContent.includes("Not sent: the same image") };
});
check("T3  a rewritten Same-as is not Same-as any more", !t3.same && /peak circled/.test(t3.context || "") && !t3.pane, JSON.stringify(t3));

// ---------- U: bug round 4
// U1: editing a slide flags the one after it at once, not on the next redraw.
const u1 = await page.evaluate(() => {
  const [, x, y] = [...jobs.values()].filter((j) => segmentLabel(j) === "Tee_S1");
  for (const j of [x, y]) { j.state = "done"; j.approved = false; }
  x.resultHtml = "<h2>Tee</h2><p>one</p>"; x.resultText = "Tee one";
  y.resultHtml = "<h2>Tee</h2><p>two</p>"; y.resultText = "Tee two"; y.contextFrom = contextRecord(x, contextHtml(x));
  renderAll();
  const before = y.railEl.textContent.replace(/\s+/g, " ");
  selectJob(x.id); toggleEdit(x.id);
  els.detailPane.querySelector(".js-preview").innerHTML = "<h2>Tee</h2><p>one, edited</p>";
  commitEdit();
  return { before, after: y.railEl.textContent.replace(/\s+/g, " ") };
});
check("U1  editing a slide flags the next one at once", !/Check:/.test(u1.before) && /Check: the visual before it changed/.test(u1.after), JSON.stringify(u1));

// U2: un-approving a slide updates its segment's count.
await page.setInputFiles("#railFileInput", [{ name: "Vee_S1_00-00-01.png", mimeType: "image/png", buffer: await tImg("vee") }]);
await page.waitForFunction(() => document.querySelectorAll("#railList .rail-segment-toggle").length >= 2);
const u2 = await page.evaluate(() => {
  const tee = [...jobs.values()].filter((j) => segmentLabel(j) === "Tee_S1");
  tee.forEach((j) => { j.approved = false; });
  renderAll();
  const head = () => [...document.querySelectorAll("#railList .rail-segment-toggle")].find((b) => /^Tee_S1/.test(b.textContent)).textContent;
  const x = tee[1];
  toggleApprove(x.id);
  const approved = head();
  toggleApprove(x.id);
  return { approved, unapproved: head() };
});
check("U2  un-approving a slide updates its segment's count", /1 approved/.test(u2.approved) && /0 approved/.test(u2.unapproved), JSON.stringify(u2));

// ---------- R14: bug round 14 (the review's second pass)
// R14a: a folder picked on its own keeps its name if it would merge with one
// from an earlier pick.
const r14a = await page.evaluate(() => {
  const [first] = [...jobs.values()];
  const keep = first.folderName;
  first.folderName = "Slides";
  const f = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
  fileFolders.set(f, "/Lecture 3/Slides/a.png");
  nameFolders([f]);
  const name = folderOfFile(f);
  first.folderName = keep;
  return name;
});
check("R14  a second pick's same-named folder stays a segment of its own", r14a === "Lecture 3/Slides", r14a);

// R14b: Sort by position keeps segments together, so it holds.
const r14b = await page.evaluate(() => {
  const saved = [...jobs.entries()];
  const mk = (id, videoName, slidePosition) => [id, { id, name: id, videoName, slidePosition, captureSeconds: null, folderName: null }];
  jobs.clear();
  for (const [id, j] of [mk("s3cap", "Lec_S3", null), mk("s3b", "Lec_S3", 2), mk("s3a", "Lec_S3", 1), mk("s2b", "Lec_S2", 2), mk("s2a", "Lec_S2", 1)]) jobs.set(id, j);
  const order = positionOrder();
  // what the rail would do with it on the next redraw
  const regrouped = [];
  const seen = new Map();
  for (const id of order) { const k = segmentKey(jobs.get(id)); if (!seen.has(k)) seen.set(k, []); seen.get(k).push(id); }
  for (const ids of seen.values()) regrouped.push(...ids);
  jobs.clear();
  for (const [id, j] of saved) jobs.set(id, j);
  return { order: order.join(), holds: order.join() === regrouped.join() };
});
check("R14  Sort by position keeps each segment together, so it holds", r14b.holds && r14b.order === "s2a,s2b,s3cap,s3a,s3b", JSON.stringify(r14b));

// R14c: a slide dropped on another segment's row stays where it was.
const r14c = await page.evaluate(() => {
  const list = [...jobs.values()];
  const from = list.find((j) => segmentLabel(j) === "Vee_S1");
  const onto = list.find((j) => segmentLabel(j) === "Tee_S1");
  const before = [...jobs.keys()].join();
  draggedJobId = from.id;
  onto.railEl.closest("li").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientY: 0, dataTransfer: new DataTransfer() }));
  draggedJobId = null;
  return { same: [...jobs.keys()].join() === before, status: document.getElementById("statusMessage").textContent };
});
check("R14  a slide dropped on another segment stays put, and says why", r14c.same && /moves within its own segment/.test(r14c.status), JSON.stringify(r14c));

// ---------- R15: bug round 15 (the review's third pass)
// R15a: segments go in order by Sort by position too: S3 added before S2.
const r15a = await page.evaluate(() => {
  const saved = [...jobs.entries()];
  const mk = (id, videoName, slidePosition) => [id, { id, name: id, videoName, slidePosition, captureSeconds: null, folderName: null }];
  jobs.clear();
  for (const [id, j] of [mk("s3a", "Lec_S3", 1), mk("s3b", "Lec_S3", 2), mk("s2a", "Lec_S2", 1), mk("s2b", "Lec_S2", 2)]) jobs.set(id, j);
  const order = positionOrder();
  jobs.clear();
  for (const [id, j] of saved) jobs.set(id, j);
  return order && order.join();
});
check("R15  Sort by position puts S2's segment before S3's", r15a === "s2a,s2b,s3a,s3b", r15a);

// R15b: two folders of slides, each picked by itself, both named "Slides".
const r15b = await page.evaluate(() => {
  const [first, second] = [...jobs.values()];
  const keep = [first.folderName, second.folderName];
  const pick = () => { const f = new File([new Uint8Array([1])], "a.png", { type: "image/png" }); fileFolders.set(f, "Slides/a.png"); nameFolders([f]); return folderOfFile(f); };
  first.folderName = "Slides"; second.folderName = null;
  const once = pick();
  second.folderName = "Slides (2)";
  const twice = pick();
  first.folderName = null; second.folderName = null;
  const fresh = pick();
  [first.folderName, second.folderName] = keep;
  return [once, twice, fresh].join();
});
check("R15  a folder picked by itself that shares a name is numbered", r15b === "Slides (2),Slides (3),Slides", r15b);

// R15c: at 320px wide the rail's menus stay on the screen.
await page.setViewportSize({ width: 320, height: 700 });
await page.evaluate(() => document.querySelector("#railAddBtn").scrollIntoView());
await page.click("#railAddBtn");
const r15c = await page.evaluate(() => {
  const m = [...document.querySelectorAll(".rail-menu")].find((x) => !x.hidden && x.offsetParent);
  const r = m.getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), vw: innerWidth };
});
await page.keyboard.press("Escape");
await page.setViewportSize({ width: 1280, height: 800 });
check("R15  at 320px the Add menu stays on the screen", r15c.left >= 0 && r15c.right <= r15c.vw && r15c.width >= 260, JSON.stringify(r15c));

check("Z  no console errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
fs.rmSync(root, { recursive: true, force: true });
await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
