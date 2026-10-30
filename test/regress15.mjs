// The video team's exporter names each still after its video, with the time
// it appears and its position in the video — in one of two orders:
//
//   UCE_0004_M3_V3_S5_Selin_0001_00-00-01    position, then time
//   UCE_0004_M3_V3_S5_Selin__0001_00-00-01   …the same, with a doubled underscore
//   UCE_0004_M3_V3_S5_Selin_00-00-01-03      time, then position
//
// Before these were understood, neither paired with UCE_0004_M3_V3_S5_Selin.srt,
// and the last read as 1:03 into a video called "…_Selin_00" — a wrong time
// that the export printed as "Visual in video at 1:03". These suites pin both
// the matching and the optional sort by position.
import { launch, makeImage, openWorkspace, addFiles, srt } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const V5 = "UCE_0004_M3_V3_S5_Selin";
const V6 = "UCE_0004_M3_V3_S6_Selin";

// Captions with words that only occur at known times, so an excerpt shows
// which moment of the talk it was cut from.
const cuesFor = (tag) => {
  const cues = [];
  for (let t = 0; t < 300; t += 10) cues.push({ start: t, end: t + 9, text: `${tag} marker at second ${t}` });
  return cues;
};
const srtFile = (video, tag = "talk") => ({ name: `${video}.srt`, mimeType: "text/plain", buffer: Buffer.from(srt(cuesFor(tag))) });

const { b, page, problems } = await launch();
// exportBlockFor builds each block in a detached element, and the browser
// fetches an <img>'s src even there — so calling it (M2) requests
// /static/<name> and gets a 404. A known, pre-existing quirk of the export,
// pinned in regress.mjs E2. Recorded by path so that ONLY those are excused.
const notFound = [];
page.on("response", (r) => { if (r.status() === 404) notFound.push(new URL(r.url()).pathname); });
await openWorkspace(page);
const png = await makeImage(page, { label: "s" });
const img = (name) => ({ name, mimeType: "image/png", buffer: png });

const jobsNow = () => page.evaluate(() => [...jobs.values()].map((j) => ({
  name: j.name, video: j.videoName, at: j.captureSeconds, pos: j.slidePosition, excerpt: j.transcriptContext || "",
})));
const fresh = async () => {
  await page.evaluate(() => { if (jobs.size) newBatch(); });
  await page.waitForFunction(() => jobs.size === 0);
};
const byName = (rows, n) => rows.find((r) => r.name === n);

// ---------- M1: all three exporter shapes pair with their transcript
await addFiles(page, [srtFile(V5)]);
await page.waitForTimeout(300);
const SHAPES = [
  [`${V5}_00-00-01-03.png`, 1, 3],
  [`${V5}_0001_00-00-01.png`, 1, 1],
  [`${V5}__0002_00-00-40.png`, 40, 2],
];
await addFiles(page, SHAPES.map(([n]) => img(n)));
await page.waitForFunction(() => jobs.size === 3);
await page.waitForTimeout(400);
let rows = await jobsNow();
for (const [name, at, pos] of SHAPES) {
  const r = byName(rows, name);
  check(`M1  ${name.slice(V5.length)} pairs with ${V5}.srt`, r.video === V5 && !!r.excerpt, `video=${r.video}`);
  check(`M1  …read at ${at}s, position ${pos}`, r.at === at && r.pos === pos, `at=${r.at} pos=${r.pos}`);
}
check("M1  the excerpt is cut from the right moment",
  /second 40/.test(byName(rows, `${V5}__0002_00-00-40.png`).excerpt) &&
  !/second 200/.test(byName(rows, `${V5}__0002_00-00-40.png`).excerpt));
check("M1  nothing is left in the Unmatched drawer",
  await page.evaluate(() => document.getElementById("railTranscripts").hidden));

// ---------- M2: the export prints the real time, not 1:03
const exported = await page.evaluate((n) => {
  const job = [...jobs.values()].find((j) => j.name === n);
  job.resultHtml = "<h3>Past and present climate</h3><p>A title card.</p>";
  return exportBlockFor({ job, imageName: n, titleLevel: 3, position: 1, total: 1 }).html;
}, `${V5}_00-00-01-03.png`);
check("M2  the export says the slide is at 0:01", /Visual in video at <time[^>]*>0:01</.test(exported),
  (exported.match(/Visual in video at <time[^>]*>[^<]*/) || ["(no timestamp)"])[0]);
check("M2  …and not at 1:03, as it used to", !/1:03/.test(exported));

// ---------- M3: slides first, transcript after — the same result
await fresh();
await addFiles(page, SHAPES.map(([n]) => img(n)));
await page.waitForFunction(() => jobs.size === 3);
await page.waitForTimeout(300);
await addFiles(page, [srtFile(V5)]);
await page.waitForTimeout(500);
rows = await jobsNow();
check("M3  slides added before their transcript still pair with it",
  SHAPES.every(([n]) => byName(rows, n).video === V5 && byName(rows, n).excerpt),
  rows.map((r) => `${r.name.slice(V5.length)}→${r.video === V5 ? "ok" : r.video}`).join(" "));

// ---------- M4: a name that splits two ways is settled by the transcript
// "Lecture_0012_00-04-32" is either slide 12 of "Lecture" or a slide of
// "Lecture_0012". With nothing loaded the name guesses the first; when
// Lecture_0012.srt arrives, the slide must be re-read as belonging to it.
await fresh();
await addFiles(page, [img("Lecture_0012_00-04-32.png")]);
await page.waitForFunction(() => jobs.size === 1);
await page.waitForTimeout(300);
await addFiles(page, [srtFile("Lecture_0012")]);
await page.waitForTimeout(500);
rows = await jobsNow();
check("M4  a later transcript settles where the name splits",
  rows[0].video === "Lecture_0012" && !!rows[0].excerpt && rows[0].at === 272,
  `video=${rows[0].video} at=${rows[0].at} excerpt=${!!rows[0].excerpt}`);
check("M4  …and the guessed position is dropped with the guess", rows[0].pos === null, `pos=${rows[0].pos}`);

// A year is never read as a position, with or without a transcript.
await fresh();
await addFiles(page, [img("Lecture_2024_00-04-32.png")]);
await page.waitForFunction(() => jobs.size === 1);
await page.waitForTimeout(300);
rows = await jobsNow();
check("M4  a year in a name is not taken for a slide position",
  rows[0].video === "Lecture_2024" && rows[0].pos === null, `video=${rows[0].video} pos=${rows[0].pos}`);

// ---------- S1: the sort is offered only when it would change something
const offer = () => page.evaluate(() => ({
  shown: !document.getElementById("railSort").hidden,
  btn: document.getElementById("railSortBtn").textContent,
}));
const railNames = () => page.evaluate(() => [...document.querySelectorAll("#railList .rail-name")].map((n) => n.textContent));

await fresh();
await addFiles(page, [img(`${V5}_0001_00-00-01.png`), img(`${V5}_0002_00-00-40.png`)]);
await page.waitForFunction(() => jobs.size === 2);
await page.waitForTimeout(300);
check("S1  no offer when the slides are already in order", !(await offer()).shown);

await fresh();
await addFiles(page, [img("Lecture_3_00-04-32.png"), img("Lecture_3_00-01-00.png")]);
await page.waitForFunction(() => jobs.size === 2);
await page.waitForTimeout(300);
check("S1  no offer for slides that carry no position", !(await offer()).shown);

// ---------- S2: the sort itself
await fresh();
const MESSY = [
  `${V5}_0003_00-01-10.png`,
  `${V6}_00-00-20-02.png`,
  `${V5}_00-00-01-01.png`,
  "whiteboard photo.png",
  `${V5}__0002_00-00-40.png`,
  `${V6}_0001_00-00-05.png`,
];
await addFiles(page, MESSY.map(img));
await page.waitForFunction(() => jobs.size === 6);
await page.waitForTimeout(400);
let o = await offer();
check("S2  offered for a batch out of position order", o.shown && o.btn === "Sort by position", o.btn);
check("S2  …and the batch is NOT reordered until asked", JSON.stringify(await railNames()) === JSON.stringify(MESSY));

await page.click("#railSortBtn");
await page.waitForTimeout(300);
const sorted = await railNames();
check("S2  sorts by position, grouping each video's slides together",
  JSON.stringify(sorted) === JSON.stringify([
    `${V5}_00-00-01-01.png`,
    `${V5}__0002_00-00-40.png`,
    `${V5}_0003_00-01-10.png`,
    "whiteboard photo.png",
    `${V6}_0001_00-00-05.png`,
    `${V6}_00-00-20-02.png`,
  ]), sorted.join(" | "));
check("S2  a slide with no position keeps its place", sorted[3] === "whiteboard photo.png");
check("S2  the jobs follow the rail — it is the batch order, not just the display",
  JSON.stringify(await page.evaluate(() => [...jobs.values()].map((j) => j.name))) === JSON.stringify(sorted));

// ---------- S3: undo
o = await offer();
check("S3  after sorting, the offer becomes Undo", o.shown && o.btn === "Undo sort", o.btn);
await page.click("#railSortBtn");
await page.waitForTimeout(300);
check("S3  Undo puts back exactly the order before", JSON.stringify(await railNames()) === JSON.stringify(MESSY));
check("S3  …and the offer to sort comes back", (await offer()).btn === "Sort by position");

// A hand move after sorting retires Undo: undoing would discard it.
await page.click("#railSortBtn");
await page.waitForTimeout(300);
await page.evaluate(() => moveJob([...jobs.keys()][0], 1));
await page.waitForTimeout(300);
o = await offer();
check("S3  moving a slide by hand retires Undo", o.btn !== "Undo sort", `${o.shown ? o.btn : "hidden"}`);

// ---------- S4: the position survives saving and reopening
await fresh();
await addFiles(page, [img(`${V5}_0002_00-00-40.png`), img(`${V5}_0001_00-00-01.png`)]);
await page.waitForFunction(() => jobs.size === 2);
await page.waitForTimeout(300);
const reopened = await page.evaluate(() => {
  const record = JSON.parse(JSON.stringify(serializeProject()));
  loadProjectRecord(record);
  return [...jobs.values()].map((j) => j.slidePosition);
});
check("S4  slide positions survive save and open", JSON.stringify(reopened) === "[2,1]", JSON.stringify(reopened));
check("S4  …so the sort is still on offer after reopening", (await offer()).shown);

check("Z  the only 404s are the export's detached /static/ <img> fetches",
  notFound.every((u) => u.startsWith("/static/")), notFound.join(", "));
const realProblems = problems.filter((m) => !/status of 404/.test(m));
check("Z  no other console errors or CSP violations", realProblems.length === 0, realProblems.join(" | "));

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
