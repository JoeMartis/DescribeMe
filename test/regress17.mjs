// No "read as" line after equations. Earlier builds asked for a plain-language
// reading in a <span class="sr-note"> after every equation; nothing hid it, so
// it showed in the course as the equation again in words, and screen readers
// already read the MathML. The prompts no longer ask for it, and descriptions
// that still carry one lose it on every way back in: a fresh result, an
// imported project file, and a project opened from the browser's store.
import { launch, makeImage, openWorkspace, addFiles } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const { b, page, problems } = await launch();
// Calling exportBlockFor (R4) fetches /static/<name> for the block's <img>
// and gets a 404 — the known quirk explained in regress15. Recorded by path
// so that only those are excused.
const notFound = [];
page.on("response", (r) => { if (r.status() === 404) notFound.push(new URL(r.url()).pathname); });

// What an old-style answer looked like: a reading inline after the equation,
// and one in a paragraph of its own.
const OLD_STYLE =
  `<h2>Gibbs free energy</h2>` +
  `<p><math><mi>ΔG</mi><mo>=</mo><mi>ΔH</mi><mo>−</mo><mi>T</mi><mi>ΔS</mi></math> ` +
  `<span class="sr-note">read as: delta G equals delta H minus T delta S</span></p>` +
  `<p><math><mi>K</mi></math></p><p><span class="sr-note">read as: K</span></p>` +
  `<p>Body text stays.</p>`;

await page.route("**/v1/messages", (route) => route.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({ stop_reason: "end_turn", model: "claude-sonnet-5", content: [{ type: "text", text: OLD_STYLE }] }),
}));

await openWorkspace(page);
await page.evaluate(() => {
  const k = document.getElementById("apiKey");
  k.value = "sk-test"; k.dispatchEvent(new Event("input", { bubbles: true }));
});

// A description with the reading gone: both equations and the body survive,
// the paragraph that held only a reading does not.
const clean = (html) => ({
  noNote: !/sr-note/.test(html),
  noReadAs: !/read as/i.test(html),
  maths: (html.match(/<math/g) || []).length === 2,
  body: html.includes("Body text stays."),
  noEmptyP: !/<p>\s*<\/p>/.test(html),
});
const allClean = (c) => Object.values(c).every(Boolean);

// ---------- R1: neither prompt asks for a reading, and both forbid one
const prompts = await page.evaluate(() => ({
  describe: buildSystemPrompt(VERBOSITY_LEVELS[1], "", false),
  ocr: buildSystemPrompt(VERBOSITY_LEVELS[1], "", true),
}));
for (const [label, p] of Object.entries(prompts)) {
  check(`R1  ${label} prompt does not ask for sr-note or "read as"`, !/sr-note|read as/i.test(p));
  check(`R1  ${label} prompt says not to add a spoken reading`,
    /Do not\s+follow (it|an equation) with a spoken or plain-language reading/.test(p));
}

// ---------- R2: a fresh result arrives without its readings
const png = await makeImage(page, { label: "equations" });
await addFiles(page, [{ name: "eq1.png", mimeType: "image/png", buffer: png }]);
await page.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length === 1);
await page.click("#detailPane .js-pending-ocr");
await page.waitForFunction(() => [...jobs.values()][0]?.state === "done", null, { timeout: 10000 });
const fresh = await page.evaluate(() => {
  const job = [...jobs.values()][0];
  return { html: job.resultHtml, text: job.resultText, shown: document.querySelector("#detailPane .result-preview")?.innerHTML || "" };
});
const freshClean = clean(fresh.html);
check("R2  stored description has no reading", allClean(freshClean), JSON.stringify(freshClean));
check("R2  nor does its plain text", !/read as/i.test(fresh.text));
check("R2  nor what the preview shows", !/sr-note|read as/i.test(fresh.shown) && /<math/.test(fresh.shown));

// ---------- R3: an imported project file
const imported = await page.evaluate((html) => {
  const record = importedProjectRecord({
    format: PROJECT_FILE_FORMAT, name: "Old project",
    jobs: [{ name: "a.png", state: "done", resultHtml: html, dataUrl: "data:image/png;base64,iVBORw0KGgo=" }],
  });
  return record.jobs[0].resultHtml;
}, OLD_STYLE);
const importedClean = clean(imported);
check("R3  imported project loses the reading", allClean(importedClean), JSON.stringify(importedClean));

// ---------- R4: a project opened from the store, and what it then exports
// The record is a real save of the batch on screen, with its description
// swapped for one written before — exactly what an older project holds.
const opened = await page.evaluate((html) => {
  const record = serializeProject();
  record.jobs[0].resultHtml = html;
  record.jobs[0].resultText = "read as: delta G equals delta H minus T delta S";
  loadProjectRecord(record);
  const job = [...jobs.values()][0];
  const block = exportBlockFor({ job, imageName: "b.png", titleLevel: 2, position: 1, total: 1 });
  return { html: job.resultHtml, text: job.resultText, exported: typeof block === "string" ? block : block.html || JSON.stringify(block) };
}, OLD_STYLE);
const openedClean = clean(opened.html);
check("R4  opened project loses the reading", allClean(openedClean), JSON.stringify(openedClean));
check("R4  and its plain text is rebuilt without it", !/read as/i.test(opened.text), opened.text.slice(0, 60));
check("R4  and the export carries none", !/sr-note|read as/i.test(opened.exported) && /<math/.test(opened.exported));

// ---------- R5: a description without readings comes through untouched
const untouched = await page.evaluate(() => {
  const html = "<h2>T</h2><p><math><mi>x</mi></math></p><p></p><p>Note.</p>";
  const holder = document.createElement("div");
  holder.appendChild(sanitizeHtmlFragment(html));
  return holder.innerHTML === html;
});
check("R5  descriptions with no reading are left exactly as they were", untouched);

check("Z  the only 404s are the export's detached /static/ <img> fetches",
  notFound.every((u) => u.startsWith("/static/")), notFound.join(", "));
const realProblems = problems.filter((m) => !/status of 404/.test(m));
check("Z  no other console errors or CSP violations", realProblems.length === 0, realProblems.join(" | "));

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
