// The transcript cliff: a captions file that stops before the recording does.
// Slides past that point get no terminology grounding, and the app used to say
// nothing about it anywhere.
import { launch, makeImage, openWorkspace, addFiles, srt } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const { b, page, problems } = await launch();
await openWorkspace(page);

// Captions covering 0:00–4:00 only.
const cues = [];
for (let t = 0; t < 240; t += 20) cues.push({ start: t, end: t + 19, text: `the lecturer speaking at ${t} seconds` });

// Six slides across 0:30–9:10. The first three fall inside the captions,
// the last three fall past the end of them.
const stamps = ["00-00-30", "00-01-40", "00-03-30", "00-05-10", "00-07-00", "00-09-10"];
const files = [];
for (const s of stamps) {
  files.push({ name: `Lecture_3_${s}.png`, mimeType: "image/png", buffer: await makeImage(page, { label: s }) });
}
files.push({ name: "Lecture_3.srt", mimeType: "text/plain", buffer: Buffer.from(srt(cues)) });
await addFiles(page, files);
await page.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length === 6);
await page.waitForTimeout(400);

// ---------- C1: the split happened where we expect
const states = await page.evaluate(() =>
  [...document.querySelectorAll("#railList .rail-row")].map((r) => r.dataset.transcript));
check("C1  three slides got captions", states.filter((s) => s === "yes").length === 3, states.join(","));
check("C1  three slides are marked as a gap, not as having no transcript",
  states.filter((s) => s === "gap").length === 3, states.join(","));
check("C1  no slide is silently 'no'", states.filter((s) => s === "no").length === 0, states.join(","));
// The edge colour must not be the only carrier.
const railText = await page.evaluate(() =>
  [...document.querySelectorAll("#railList .rail-row")].map((r) => r.querySelector(".rail-status").textContent));
check("C1  covered rows name the transcript in text",
  railText.slice(0, 3).every((t) => /Lecture_3\.srt/.test(t)), railText[0]);
check("C1  gap rows say 'no captions' in text, not just in colour",
  railText.slice(3).every((t) => /no captions/.test(t)), railText[5]);

// ---------- C2: a covered slide reads as covered
await page.evaluate(() => [...document.querySelectorAll("#railList .rail-row")][0].click());
await page.waitForTimeout(250);
let meta = await page.textContent("#detailPane .js-slide-meta");
check("C2  a covered slide names its transcript", /Transcript Lecture_3\.srt/.test(meta), meta);

// ---------- C3: a cliff slide SAYS SO — the whole point
await page.evaluate(() => [...document.querySelectorAll("#railList .rail-row")][5].click());
await page.waitForTimeout(250);
meta = await page.textContent("#detailPane .js-slide-meta");
check("C3  a slide past the cliff says it got no captions", /No captions near/.test(meta), meta);
check("C3  it names the time it needed", /9:10/.test(meta), meta);
check("C3  it names the file and where the captions stop",
  /Lecture_3\.srt/.test(meta) && /runs through 3:5\d|runs through 4:00/.test(meta), meta);

// ---------- C4: the drawer reports the partial coverage instead of hiding it
const drawer = await page.evaluate(() => ({
  hidden: document.getElementById("railTranscripts").hidden,
  title: document.getElementById("railTranscriptsTitle").textContent,
  count: document.getElementById("railTranscriptsCount").textContent,
  rows: [...document.querySelectorAll("#transcriptList .transcript-item")].map((li) => ({
    matched: li.dataset.matched,
    text: li.querySelector(".rail-status").textContent,
    detach: li.querySelector(".transcript-detach").getAttribute("aria-label"),
  })),
}));
check("C4  the drawer is shown for a partially-covered transcript", drawer.hidden === false);
check("C4  and is not titled 'Unmatched' — the file matched fine",
  drawer.title === "Transcripts to check", drawer.title);
check("C4  the row is marked partial", drawer.rows.length === 1 && drawer.rows[0].matched === "partial",
  JSON.stringify(drawer.rows.map((r) => r.matched)));
check("C4  it counts the slides that missed out",
  /3 of 6 slides got no captions/.test(drawer.rows[0]?.text || ""), drawer.rows[0]?.text);
check("C4  and says where the captions stop",
  /captions run through/.test(drawer.rows[0]?.text || ""), drawer.rows[0]?.text);
check("C4  detach warns what it would cost",
  /removes captions from the 3 slides that have them/.test(drawer.rows[0]?.detach || ""), drawer.rows[0]?.detach);

// ---------- C5: full coverage still reports nothing at all
{
  const { b: b2, page: p2 } = await launch();
  await openWorkspace(p2);
  const full = [];
  for (const s of ["00-00-30", "00-01-40", "00-03-30"]) {
    full.push({ name: `Lecture_3_${s}.png`, mimeType: "image/png", buffer: await makeImage(p2, { label: s }) });
  }
  full.push({ name: "Lecture_3.srt", mimeType: "text/plain", buffer: Buffer.from(srt(cues)) });
  await addFiles(p2, full);
  await p2.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length === 3);
  await p2.waitForTimeout(400);
  const r = await p2.evaluate(() => ({
    hidden: document.getElementById("railTranscripts").hidden,
    states: [...document.querySelectorAll("#railList .rail-row")].map((x) => x.dataset.transcript),
  }));
  check("C5  a fully-covered transcript shows no drawer", r.hidden === true);
  check("C5  and every slide reads as covered", r.states.every((s) => s === "yes"), r.states.join(","));
  await b2.close();
}

// ---------- C6: a slide with no transcript in scope stays quiet
{
  const { b: b3, page: p3 } = await launch();
  await openWorkspace(p3);
  await addFiles(p3, [{ name: "unrelated.png", mimeType: "image/png", buffer: await makeImage(p3, { label: "x" }) }]);
  await p3.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length === 1);
  await p3.waitForTimeout(300);
  const state = await p3.evaluate(() => document.querySelector("#railList .rail-row").dataset.transcript);
  const m = await p3.textContent("#detailPane .js-slide-meta");
  check("C6  a slide no transcript claims is 'no', not a gap", state === "no", state);
  check("C6  and says nothing about captions", !/captions/i.test(m), m);
  await b3.close();
}

check("Z  no console errors or CSP violations", problems.length === 0, problems.join(" | "));

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
