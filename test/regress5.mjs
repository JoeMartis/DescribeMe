// Export heading levels and slide counts.
import fs from "node:fs";
import { launch, makeImage, openWorkspace, outDir } from "./fixtures.mjs";

const OUT = outDir();
const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

function unzipStore(buf) {
  const files = {}; let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const size = buf.readUInt32LE(off + 18), n = buf.readUInt16LE(off + 26), e = buf.readUInt16LE(off + 28);
    files[buf.toString("utf8", off + 30, off + 30 + n)] = buf.subarray(off + 30 + n + e, off + 30 + n + e + size);
    off += 30 + n + e + size;
  }
  return files;
}
const project = (name, jobs) => ({ format: "describeme-project", version: 1, name, savedAt: new Date().toISOString(), jobs });

// The caller has already opened the workspace (it needs the page to build
// fixture images), so this only imports and opens the project.
async function setup(page, jobs, name = "Cell Biology") {
  await page.click("#projectsBtn");
  await page.setInputFiles("#importProjectInput", [{ name: "p.describeme.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(project(name, jobs))) }]);
  await page.waitForSelector(`#projectList button[aria-label="Open project ${name}"]`);
  await page.click(`#projectList button[aria-label="Open project ${name}"]`);
  await page.waitForFunction((c) => document.querySelectorAll("#railList li").length === c, jobs.length);
  if (await page.$eval("#projectsDialog", (d) => d.open)) await page.click("#projectsClose");
}
async function configure(page, { level, batchHeading, counts }) {
  await page.click("#settingsChip");
  if (level !== undefined) await page.selectOption("#exportHeadingLevel", String(level));
  if (batchHeading !== undefined && (await page.$eval("#exportBatchHeading", (c) => c.checked)) !== batchHeading) await page.click("#exportBatchHeading");
  if (counts !== undefined && (await page.$eval("#exportSlideCounts", (c) => c.checked)) !== counts) await page.click("#exportSlideCounts");
  await page.click("#settingsClose");
}
async function exportHtml(page, label) {
  const dl = page.waitForEvent("download", { timeout: 6000 }).catch(() => null);
  await page.click("#exportBtn");
  const d = await dl;
  const status = await page.$eval("#statusMessage", (e) => e.textContent.trim());
  if (!d) return { html: null, status };
  const p = `${OUT}/${label}.zip`; await d.saveAs(p);
  return { html: unzipStore(fs.readFileSync(p))["description.html"].toString(), status };
}
// The heading tags in document order.
const tags = (html) => [...html.matchAll(/<(h[1-6])\b/g)].map((m) => m[1]);

async function jobFor(page, name, resultHtml) {
  const img = await makeImage(page, { w: 400, h: 225, label: name });
  return { name, state: "done", approved: true, history: [], resultHtml, resultText: "t", dataUrl: `data:image/jpeg;base64,${img.toString("base64")}`, mediaType: "image/jpeg", width: 400, height: 225 };
}

// ---------- H1: default level 3, relative shift, no batch heading
{
  const { b, page, problems } = await launch({ acceptDownloads: true });
  await openWorkspace(page);
  const a = await jobFor(page, "one.png", "<h2>Cell cycle</h2><p>Summary.</p><h3>Phases</h3><p>Detail.</p>");
  const c = await jobFor(page, "two.png", "<h2>Mitosis</h2><p>Summary.</p>");
  await setup(page, [a, c]);
  await configure(page, { level: 3, batchHeading: false, counts: false });
  const r = await exportHtml(page, "h1");
  check("H1  default starts visual titles at h3 and shifts subheadings to h4", JSON.stringify(tags(r.html)) === JSON.stringify(["h3", "h4", "h3"]), tags(r.html).join(","));
  check("H1  no h1 or h2 is emitted at all", !/<h[12]\b/.test(r.html));
  check("H1  tabindex lands on the visual title, not a subheading", /<h3 tabindex="0">Cell cycle<\/h3>/.test(r.html) && !/<h4 tabindex/.test(r.html), (r.html.match(/<h[34][^>]*>/g) || []).join(" "));
  check("H1  no page errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
  await b.close();
}

// ---------- H2: level 2 keeps the old shape; level 4 pushes both down
{
  const { b, page, problems } = await launch({ acceptDownloads: true });
  await openWorkspace(page);
  const a = await jobFor(page, "one.png", "<h2>Cell cycle</h2><p>Summary.</p><h3>Phases</h3><p>Detail.</p>");
  await setup(page, [a]);
  await configure(page, { level: 2, batchHeading: false, counts: false });
  let r = await exportHtml(page, "h2a");
  check("H2  level 2 gives h2 + h3", JSON.stringify(tags(r.html)) === JSON.stringify(["h2", "h3"]), tags(r.html).join(","));
  await configure(page, { level: 4 });
  r = await exportHtml(page, "h2b");
  check("H2  level 4 gives h4 + h5", JSON.stringify(tags(r.html)) === JSON.stringify(["h4", "h5"]), tags(r.html).join(","));
  check("H2  no page errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
  await b.close();
}

// ---------- H3: the h6 clamp is applied and reported
{
  const { b, page, problems } = await launch({ acceptDownloads: true });
  await openWorkspace(page);
  const deep = await jobFor(page, "deep.png", "<h2>T</h2><p>s</p><h3>A</h3><h4>B</h4><h5>C</h5>");
  await setup(page, [deep]);
  await configure(page, { level: 4, batchHeading: false, counts: false });
  const r = await exportHtml(page, "h3");
  check("H3  deepest levels clamp at h6 rather than emitting h7", JSON.stringify(tags(r.html)) === JSON.stringify(["h4", "h5", "h6", "h6"]), tags(r.html).join(","));
  check("H3  the clamp is reported, naming the fix", /capped at h6/.test(r.status) && /shallower/.test(r.status), r.status);
  check("H3  no page errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
  await b.close();
}

// ---------- H4: slide counts, with and without the batch heading
{
  const { b, page, problems } = await launch({ acceptDownloads: true });
  await openWorkspace(page);
  const a = await jobFor(page, "one.png", "<h2>Cell cycle</h2><p>s</p>");
  const c = await jobFor(page, "two.png", "<h2>Mitosis</h2><p>s</p>");
  await setup(page, [a, c]);
  await configure(page, { level: 3, batchHeading: true, counts: true });
  let r = await exportHtml(page, "h4a");
  check("H4  batch heading sits one level above the titles and states the total", /<h2>Cell Biology — 2 visuals<\/h2>/.test(r.html), (r.html.match(/<h2>[^<]*<\/h2>/) || [])[0]);
  check("H4  each visual title carries its position", /Visual 1 of 2: <\/span>Cell cycle/.test(r.html) && /Visual 2 of 2: <\/span>Mitosis/.test(r.html), (r.html.match(/Visual \d of \d/g) || []).join(" "));
  check("H4  the count is inside the title heading, not a sibling", /<h3 tabindex="0"><span class="visual-count">Visual 1 of 2: <\/span>Cell cycle<\/h3>/.test(r.html));

  await configure(page, { batchHeading: false });
  r = await exportHtml(page, "h4b");
  check("H4  with no batch heading the total still leads, as a sentence", /^<p>2 visuals, described in order\.<\/p>/.test(r.html.trim()), r.html.slice(0, 60));
  // Only the export's OWN wording is asserted — a description may legitimately
  // say "microscope slide" or "the plates slide past each other", and banning
  // the word outright would corrupt the deliverable.
  check("H4  the export's own wording never calls a visual a slide", !/Slide \d+ of \d+|\d+ slides?, described|— \d+ slides?|Slide in video at|class="slide-count"/.test(r.html), (r.html.match(/[^<>]*[Ss]lide[^<>]*/) || [])[0] || "none");

  // A description that legitimately uses the word must survive intact.
  await configure(page, { batchHeading: true, counts: true });
  const bio = await jobFor(page, "bio.png", "<h2>Mitosis under the microscope</h2><p>A microscope slide holds the specimen; the plates slide past one another.</p>");
  await setup(page, [bio], "Bio terms");
  r = await exportHtml(page, "h4bio");
  check("H4  a description may still say microscope slide", /microscope slide/.test(r.html) && /plates slide past/.test(r.html), (r.html.match(/[^<>]*slide[^<>]*/) || [])[0]);
  check("H4  and the chrome around it still says visual", /Visual 1 of 1/.test(r.html) && /1 visual<\/h2>/.test(r.html), (r.html.match(/<h2>[^<]*<\/h2>/) || [])[0]);

  await setup(page, [a, c], "Cell Biology 2");
  await configure(page, { counts: false });
  r = await exportHtml(page, "h4c");
  check("H4  counts off removes every counter", !/Visual \d of \d/.test(r.html) && !/described in order/.test(r.html));
  check("H4  no page errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
  await b.close();
}

// ---------- H5: settings persist across a reload
{
  const { b, page, problems } = await launch({ acceptDownloads: true });
  await openWorkspace(page);
  await configure(page, { level: 4, batchHeading: true, counts: false });
  await page.reload({ waitUntil: "load" });
  if (!(await page.$eval("#onboarding", (o) => o.hidden))) await page.click("#onboardSkip");
  await page.click("#settingsChip");
  const state = await page.evaluate(() => ({
    level: document.getElementById("exportHeadingLevel").value,
    batch: document.getElementById("exportBatchHeading").checked,
    counts: document.getElementById("exportSlideCounts").checked,
  }));
  check("H5  heading level, batch heading and counts all persist", state.level === "4" && state.batch === true && state.counts === false, JSON.stringify(state));
  check("H5  no page errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
  await b.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
