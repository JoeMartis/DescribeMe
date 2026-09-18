// Order of the parts inside one exported description block:
// title → timestamp caption → image → summary → the rest.
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

async function setup(page, jobs, name = "Order") {
  await page.click("#projectsBtn");
  await page.setInputFiles("#importProjectInput", [{ name: "p.describeme.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(project(name, jobs))) }]);
  await page.waitForSelector(`#projectList button[aria-label="Open project ${name}"]`);
  await page.click(`#projectList button[aria-label="Open project ${name}"]`);
  await page.waitForFunction((c) => document.querySelectorAll("#railList li").length === c, jobs.length);
  if (await page.$eval("#projectsDialog", (d) => d.open)) await page.click("#projectsClose");
}
async function exportHtml(page, label) {
  const dl = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
  await page.click("#exportBtn");
  const d = await dl;
  if (!d) return null;
  const p = `${OUT}/${label}.zip`; await d.saveAs(p);
  return unzipStore(fs.readFileSync(p))["description.html"].toString();
}

async function jobFor(page, name, resultHtml, extra = {}) {
  const img = await makeImage(page, { w: 400, h: 225, label: name });
  return {
    name, state: "done", approved: true, history: [], resultHtml, resultText: "t",
    dataUrl: `data:image/jpeg;base64,${img.toString("base64")}`,
    mediaType: "image/jpeg", width: 400, height: 225, ...extra,
  };
}

/** The order the block's parts appear in, by tag/role. The document opens
    with a "N visuals, described in order." preamble that is not part of any
    block — drop it before reading the shape. */
const shape = (html) =>
  [...html.replace(/^\s*<p>[^<]*described in order\.<\/p>/, "")
    .matchAll(/<(h[1-6])\b|<(figcaption)\b|<(img)\b|<(p)\b|<(figure)\b/g)]
    .map((m) => m.slice(1).find(Boolean));

// ---------- O1: a slide captured from video — the full requested order
{
  const { b, page, problems } = await launch({ acceptDownloads: true });
  await openWorkspace(page);
  const a = await jobFor(
    page,
    "Lecture_3_00-04-32.jpg",
    "<h2>Linear regression</h2><p>Summary sentence.</p><h3>The model</h3><p>Detail.</p>",
    { captureSeconds: 272, videoName: "Lecture_3" }
  );
  await setup(page, [a]);
  const html = await exportHtml(page, "o1");
  check("O1  the zip has a description.html", !!html);

  const order = shape(html);
  check(
    "O1  title → figcaption → image → summary → the rest",
    JSON.stringify(order) === JSON.stringify(["h3", "figure", "figcaption", "img", "p", "h4", "p"]),
    order.join(" ")
  );
  check("O1  the caption is the figure's FIRST child, before the img",
    /<figure>\s*<figcaption>/.test(html) && html.indexOf("<figcaption") < html.indexOf("<img"), "");
  check("O1  the caption still carries a machine-readable time",
    /<figcaption>Visual in video at <time datetime="PT0H4M32S">4:32<\/time><\/figcaption>/.test(html),
    (html.match(/<figcaption>.*?<\/figcaption>/) || [""])[0]);
  check("O1  the summary now follows the image rather than preceding it",
    html.indexOf("<img") < html.indexOf("Summary sentence."), "");
  check("O1  the figure closes before the summary — the prose is not inside it",
    html.indexOf("</figure>") < html.indexOf("Summary sentence."), "");
  check("O1  no page errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
  await b.close();
}

// ---------- O2: an uploaded slide with no timestamp — image, no figure
{
  const { b, page, problems } = await launch({ acceptDownloads: true });
  await openWorkspace(page);
  const a = await jobFor(page, "slide7.png", "<h2>Cell cycle</h2><p>Summary.</p><p>Detail.</p>");
  await setup(page, [a]);
  const html = await exportHtml(page, "o2");
  const order = shape(html);
  check("O2  title → image → summary → the rest, with no empty figure",
    JSON.stringify(order) === JSON.stringify(["h3", "img", "p", "p"]), order.join(" "));
  check("O2  no figcaption is invented for a slide that has no timestamp",
    !/<figcaption/.test(html) && !/<figure/.test(html), "");
  check("O2  no page errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
  await b.close();
}

// ---------- O3: a description that does not open with a heading
{
  const { b, page, problems } = await launch({ acceptDownloads: true });
  await openWorkspace(page);
  const a = await jobFor(page, "Lecture_3_00-01-00.jpg", "<p>No heading at all.</p><p>More.</p>", { captureSeconds: 60 });
  await setup(page, [a]);
  const html = await exportHtml(page, "o3");
  const order = shape(html);
  check("O3  with no title, the figure still leads the block",
    JSON.stringify(order) === JSON.stringify(["figure", "figcaption", "img", "p", "p"]), order.join(" "));
  check("O3  no page errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
  await b.close();
}

// ---------- O4: the visual counter still rides on the title, ahead of everything
{
  const { b, page, problems } = await launch({ acceptDownloads: true });
  await openWorkspace(page);
  const a = await jobFor(page, "Lecture_3_00-04-32.jpg", "<h2>One</h2><p>S.</p>", { captureSeconds: 272 });
  const c = await jobFor(page, "Lecture_3_00-09-00.jpg", "<h2>Two</h2><p>S.</p>", { captureSeconds: 540 });
  await setup(page, [a, c]);
  const html = await exportHtml(page, "o4");
  check("O4  the counter is still the first thing inside the title",
    /<h3 tabindex="0"><span class="visual-count">Visual 1 of 2: <\/span>One<\/h3>/.test(html),
    (html.match(/<h3[^>]*>.*?<\/h3>/) || [""])[0]);
  check("O4  and it precedes that block's figcaption",
    html.indexOf("Visual 1 of 2") < html.indexOf("<figcaption"), "");
  check("O4  each block keeps its own caption",
    (html.match(/<figcaption/g) || []).length === 2, String((html.match(/<figcaption/g) || []).length));
  check("O4  no page errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
  await b.close();
}

// ---------- O5: a figure the MODEL produced is still flattened, not confused
// with the export's own figure
{
  const { b, page, problems } = await launch({ acceptDownloads: true });
  await openWorkspace(page);
  const a = await jobFor(
    page,
    "Lecture_3_00-04-32.jpg",
    "<h2>Chart</h2><p>Summary.</p><figure><figcaption>Model's own caption</figcaption></figure>",
    { captureSeconds: 272 }
  );
  await setup(page, [a]);
  const html = await exportHtml(page, "o5");
  check("O5  exactly one figure survives — the export's own",
    (html.match(/<figure/g) || []).length === 1, String((html.match(/<figure/g) || []).length));
  check("O5  the model's caption became a paragraph, not a second figcaption",
    (html.match(/<figcaption/g) || []).length === 1 && /<p>Model's own caption<\/p>/.test(html), "");
  check("O5  no page errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
  await b.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
