// Learner downloads — one HTML file and one PDF a learner keeps, built in the
// browser from the approved visuals.
//
// The HTML is checked as a page: complete, self-contained (no request leaves
// it), its own heading outline, MathML intact. The PDF is checked as a
// tagged document: structure, alt text on every formula, the slide images as
// artifacts, and the PDF/UA-1 identification learner-pdf.mjs appends.
//
// veraPDF is the reference PDF/UA checker. It is Java and not part of this
// repo, so it runs only when VERAPDF_LIB points at a folder of its jars (see
// test/README.md); without it, the structural checks below still run.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { launch, makeImage, openWorkspace, outDir, APP_URL } from "./fixtures.mjs";

const OUT = outDir();
const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const project = (name, jobs) => ({ format: "describeme-project", version: 1, name, savedAt: new Date().toISOString(), jobs });

const GIBBS =
  `<h2>Gibbs free energy</h2><p>The change in free energy decides whether a reaction is spontaneous.</p>` +
  `<p><math display="block"><mi>Δ</mi><mi>G</mi><mo>=</mo><mi>Δ</mi><mi>H</mi><mo>−</mo><mi>T</mi><mi>Δ</mi><mi>S</mi></math></p>` +
  `<ul><li>When <math><mi>Δ</mi><mi>G</mi><mo>&lt;</mo><mn>0</mn></math> the reaction is spontaneous.</li>` +
  `<li>Water is <math><msub><mi>H</mi><mn>2</mn></msub><mi>O</mi></math>.</li></ul>` +
  `<table><thead><tr><th>Sign of ΔH</th><th>Sign of ΔS</th></tr></thead><tbody><tr><td>−</td><td>+</td></tr></tbody></table>`;
// Every character Typst gives a meaning to, in prose and in math.
const TRICKY =
  `<h2>Quadratic formula</h2><p>Roots: <math><mi>x</mi><mo>=</mo><mfrac><mrow><mo>−</mo><mi>b</mi><mo>±</mo>` +
  `<msqrt><msup><mi>b</mi><mn>2</mn></msup><mo>−</mo><mn>4</mn><mi>a</mi><mi>c</mi></msqrt></mrow><mrow><mn>2</mn><mi>a</mi></mrow></mfrac></math></p>` +
  `<h3>Tricky characters</h3><p>Text with *asterisks*, #hash, $dollar, [brackets], = signs, &lt;angle&gt; and "quotes" \\ backslash.</p>` +
  `<p><math><mrow><mo>(</mo><mfrac><mi>a</mi><mi>b</mi></mfrac><mo>)</mo></mrow><mo>,</mo><mo>|</mo><mi>x</mi><mo>|</mo><mo>/</mo><mn>2</mn>` +
  `<mo>;</mo><mtext>rate "k" (s⁻¹)</mtext><mo>:</mo><msub><mi>k</mi><mtext>cat</mtext></msub></math></p>`;
const MATH_COUNT = 5;

const { b, page, problems } = await launch({ acceptDownloads: true });
const offSite = [];
page.on("request", (r) => { if (!r.url().startsWith(new URL(APP_URL).origin) && !/^(data|blob):/.test(r.url())) offSite.push(r.url()); });
await openWorkspace(page);

const job = async (name, resultHtml, extra = {}) => {
  const img = await makeImage(page, { w: 1200, h: 675, label: name });
  return { name, state: "done", approved: true, history: [], resultHtml, resultText: "t", dataUrl: `data:image/png;base64,${img.toString("base64")}`, mediaType: "image/png", width: 1200, height: 675, ...extra };
};
const jobs = [
  await job("Lecture_3_00-04-32.png", GIBBS, { captureSeconds: 272 }),
  await job("formula.png", TRICKY),
  await job("not-approved.png", "<h2>Should not appear</h2><p>Draft.</p>", { approved: false }),
];
await page.click("#projectsBtn");
await page.setInputFiles("#importProjectInput", [{ name: "p.describeme.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(project("Cell Biology", jobs))) }]);
await page.waitForSelector('#projectList button[aria-label="Open project Cell Biology"]');
await page.click('#projectList button[aria-label="Open project Cell Biology"]');
await page.waitForFunction(() => document.querySelectorAll("#railList li").length === 3);
if (await page.$eval("#projectsDialog", (d) => d.open)) await page.click("#projectsClose");

// ---------- L1: the button and the dialog
check("L1  For learners is enabled once something is approved", !(await page.$eval("#learnerBtn", (e) => e.disabled)));
await page.click("#learnerBtn");
check("L1  it opens the learner dialog", await page.$eval("#learnerDialog", (d) => d.open));
check("L1  which counts the approved visuals", (await page.textContent("#learnerCount")).includes("2 approved visuals"));
check("L1  HTML is offered first, as the one for most learners",
  await page.$eval("#learnerDialog", (d) => {
    const btns = [...d.querySelectorAll(".learner-option .btn")].map((x) => x.id);
    return btns[0] === "learnerHtmlBtn" && /Best for most learners/.test(d.querySelector("#learnerHtmlHint").textContent);
  }));

async function download(buttonId, ext, timeout) {
  const dl = page.waitForEvent("download", { timeout }).catch(() => null);
  await page.click(`#${buttonId}`);
  const d = await dl;
  if (!d) return { file: null, name: null };
  const file = path.join(OUT, `learner.${ext}`);
  await d.saveAs(file);
  return { file, name: d.suggestedFilename() };
}

// ---------- H: the HTML file
const html = await download("learnerHtmlBtn", "html", 15000);
check("H1  an HTML file downloads", !!html.file, html.name || "");
check("H1  named for the batch", html.name === "Cell-Biology-visual-descriptions.html", html.name || "");
const src = html.file ? fs.readFileSync(html.file, "utf8") : "";
check("H2  a whole document, in English, with a title",
  /^<!doctype html>/i.test(src) && /<html lang="en">/.test(src) && src.includes("<title>Cell Biology: visual descriptions</title>"));
check("H2  it carries its own CSP: data: images and inline styles, nothing else",
  src.includes(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`));
const tags = [...src.matchAll(/<(h[1-6])\b/g)].map((m) => m[1]).join(" ");
check("H3  outline is the batch, then one h2 per visual, subheadings below", tags === "h1 h2 h2 h3", tags);
check("H3  titles are counted", src.includes("Visual 1 of 2: ") && src.includes("Visual 2 of 2: "));
check("H3  no Studio tab stops on the titles, no inline gap styles", !/tabindex=/.test(src) && !/ style=/.test(src));
check("H4  only approved visuals", !src.includes("Should not appear"));
check("H4  images are built in, two of them, with no /static/ path left",
  (src.match(/<img src="data:image\/png;base64,/g) || []).length === 2 && !src.includes("/static/"));
// Resized to 800 px wide by default, as the zip export is.
check("H4  images say their size, so the page does not jump as they load", /<img [^>]*width="800" height="450"/.test(src));
check("H5  MathML is kept as MathML, every equation", (src.match(/<math\b/g) || []).length === MATH_COUNT);
check("H5  with no spoken reading added beside it", !/read as|sr-note/i.test(src));
check("H6  the video timestamp caption is kept", src.includes("Visual in video at <time datetime=\"PT0H4M32S\">4:32</time>"));

// Opened the way a learner opens it — from disk — it needs nothing else.
{
  const viewer = await b.newPage();
  const fetched = [];
  const errors = [];
  viewer.on("request", (r) => { if (r.url() !== pathToFileURL(html.file).href && !r.url().startsWith("data:")) fetched.push(r.url()); });
  viewer.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await viewer.goto(pathToFileURL(html.file).href);
  const imgs = await viewer.$$eval("img", (list) => list.map((i) => i.complete && i.naturalWidth > 0));
  check("H7  opened from disk, every image shows", imgs.length === 2 && imgs.every(Boolean), JSON.stringify(imgs));
  check("H7  and it requests nothing", fetched.length === 0, fetched.join(", "));
  check("H7  with no errors", errors.length === 0, errors.join(" | "));
  await viewer.close();
}

// ---------- P: the PDF
const t0 = Date.now();
const pdf = await download("learnerPdfBtn", "pdf", 120000);
const firstMs = Date.now() - t0;
const status = await page.textContent("#learnerStatus");
check("P1  a PDF downloads", !!pdf.file, `${pdf.name || ""} in ${firstMs} ms`);
check("P1  named for the batch", pdf.name === "Cell-Biology-visual-descriptions.pdf", pdf.name || "");
check("P1  every equation was typeset — none fell back to words", !/could not be typeset/.test(status), status);
check("P1  nothing was fetched from off this site to make it", offSite.length === 0, offSite.join(", "));
const bytes = pdf.file ? fs.readFileSync(pdf.file) : Buffer.alloc(0);
const raw = bytes.toString("latin1");

// Plain-text PDF objects, last definition wins — which is how a reader
// resolves an incremental update.
const objects = new Map();
for (const m of raw.matchAll(/(?:^|\n)(\d+) 0 obj([\s\S]*?)endobj/g)) objects.set(Number(m[1]), m[2]);
const structs = [...objects.values()].filter((o) => /\/S \/\w+/.test(o));
const ofType = (t) => structs.filter((o) => new RegExp(`/S /${t}\\b`).test(o));
const pdfString = (o, key) => {
  const lit = o.match(new RegExp(`/${key} \\(((?:[^()\\\\]|\\\\.)*)\\)`));
  if (lit) return lit[1].replace(/\\(.)/g, "$1");
  const hex = o.match(new RegExp(`/${key} <([0-9A-Fa-f]+)>`));
  if (!hex) return null;
  const buf = Buffer.from(hex[1], "hex");
  return buf[0] === 0xfe && buf[1] === 0xff ? buf.subarray(2).swap16().toString("utf16le") : buf.toString("latin1");
};

check("P2  starts as a PDF", raw.startsWith("%PDF-"));
check("P2  tagged: a structure tree, marked content", /\/StructTreeRoot \d+ 0 R/.test(raw) && /\/Marked true/.test(raw));
check("P2  in English", /\/Lang \(en\)/.test(raw));
check("P2  titled", raw.includes("Cell Biology: visual descriptions"));
check("P3  headings: one H1, two H2, one H3", ofType("H1").length === 1 && ofType("H2").length === 2 && ofType("H3").length === 1,
  `H1=${ofType("H1").length} H2=${ofType("H2").length} H3=${ofType("H3").length}`);
check("P3  the list and the table keep their structure", ofType("L").length >= 1 && ofType("LI").length >= 2 && ofType("TH").length === 2 && ofType("TD").length === 2);
const formulas = ofType("Formula");
const alts = formulas.map((o) => pdfString(o, "Alt"));
check("P4  every equation is a Formula", formulas.length === MATH_COUNT, `${formulas.length}`);
check("P4  and every Formula has alt text", alts.every((a) => a && a.trim()), JSON.stringify(alts));
check("P4  read as a lecture means it — Delta, not triangle", alts.includes("Delta G equals Delta H minus T Delta S"), JSON.stringify(alts));
check("P4  water as a formula, not a function of O", alts.some((a) => /^H sub 2 O$/.test(a || "")), JSON.stringify(alts));
check("P5  the slide images are artifacts, not figures without alt text", ofType("Figure").length === 0);
check("P6  claims PDF/UA-1", /<pdfuaid:part>1<\/pdfuaid:part>/.test(raw));
check("P6  and shows its title rather than its file name", /\/DisplayDocTitle true/.test(raw));
// The appended update has to point at what it says it does, or a reader
// falls back to the original catalog without either entry.
{
  const xref = Number(raw.slice(raw.lastIndexOf("startxref") + 9).trim().split(/\s+/)[0]);
  const section = raw.slice(xref, raw.indexOf("trailer", xref));
  const entries = [...section.matchAll(/(\d+) 1\n(\d{10}) 00000 n\r\n/g)];
  const ok = entries.length === 2 && entries.every(([, num, off]) => raw.startsWith(`${Number(num)} 0 obj`, Number(off)));
  check("P6  the update's cross-reference points at its objects", ok, section.slice(0, 120));
}

// The Typst it was built from: prose goes in as strings, so nothing in it
// can turn into markup.
const typst = await page.evaluate(async (file) => {
  const { learnerTypst } = await import("/learner-pdf.mjs");
  // Parsed without its <style>, as the app does — see runLearnerDownload.
  return learnerTypst(new DOMParser().parseFromString(file.replace(/<style>[\s\S]*?<\/style>/, ""), "text/html")).source;
}, src);
check("P7  prose characters Typst treats as markup arrive as plain text",
  typst.includes(`#"Text with *asterisks*, #hash, $dollar, [brackets], = signs, <angle> and \\"quotes\\" \\\\ backslash."`));

// A second PDF reuses the loaded typesetter.
{
  const t1 = Date.now();
  const again = await download("learnerPdfBtn", "again.pdf", 60000);
  check("P8  a second PDF comes from the loaded typesetter", !!again.file && Date.now() - t1 < firstMs, `${Date.now() - t1} ms vs ${firstMs} ms`);
}

// veraPDF, when it is available.
if (process.env.VERAPDF_LIB && pdf.file) {
  let report = "";
  try {
    report = execFileSync("java", ["-cp", `${process.env.VERAPDF_LIB}/*`, "org.verapdf.apps.GreenfieldCliWrapper", "-f", "ua1", "--format", "text", pdf.file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    report = String(err.stdout || err.message);
  }
  check("P9  veraPDF: PDF/UA-1 compliant", /^PASS /m.test(report), report.trim().split("\n").slice(0, 6).join(" | "));
} else {
  console.log("SKIP  P9  veraPDF — set VERAPDF_LIB to a folder of its jars to run it");
}

check("Z  no console errors or CSP violations", problems.length === 0, problems.join(" | "));

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
