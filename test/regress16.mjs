// The gap between one exported visual and the next. Blocks are joined with
// nothing between them, so the gap used to come from whatever ended the block
// before. A slide that is only a heading — a title card run through Text &
// math — ends on its image, with no margin below it, and the next visual's
// "Visual 11 of 20" title sat directly under that image, reading as its
// caption. Every visual now opens with the same gap, whatever came before.
import { launch, makeImage, openWorkspace, addFiles } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const { b, page, problems } = await launch();
// exportBlockFor builds each block in a detached element, and the browser
// fetches an <img>'s src even there — the known /static/ 404, pinned in
// regress.mjs E2. Recorded by path so that only those are excused.
const notFound = [];
page.on("response", (r) => { if (r.status() === 404) notFound.push(new URL(r.url()).pathname); });

await openWorkspace(page);
const png = await makeImage(page, { label: "s" });
await addFiles(page, ["a.png", "b.png", "c.png"].map((name) => ({ name, mimeType: "image/png", buffer: png })));
await page.waitForFunction(() => jobs.size === 3);

// The three slides as the export builds them. Slide 1 is heading-only; slide 2
// is a normal description. Built in the app, measured somewhere else: the app
// page's content security policy refuses inline styles and its stylesheet
// resets margins, and neither applies where this HTML actually goes. A blank
// page with the browser's default styles is the closer stand-in for Studio.
const html = await page.evaluate(() => {
  const [one, two, three] = [...jobs.values()];
  one.resultHtml = "<h3>Past and present climate</h3>";
  one.captureSeconds = 5;
  two.resultHtml = "<h3>Model evaluation</h3><p>A chart comparing models against observations.</p>";
  two.captureSeconds = 64;
  three.resultHtml = "<h3>Attribution</h3><p>Two panels.</p>";
  return [one, two, three]
    .map((job, i) => exportBlockFor({ job, imageName: job.name, titleLevel: 3, position: i + 1, total: 3 }).html)
    .join("\n\n");
});

const blank = await (await b.newContext({ viewport: { width: 900, height: 1600 } })).newPage();
// The images never load here; give them the size a slide would have.
await blank.setContent(
  `<!doctype html><style>body{font:16px/1.5 sans-serif;width:700px} img{display:block;width:600px;height:300px}</style>${html}`
);
const gaps = await blank.evaluate(() => {
  const titles = [...document.querySelectorAll("h3")];
  const imgs = [...document.querySelectorAll("img")];
  const top = (el) => el.getBoundingClientRect().top;
  const bottom = (el) => el.getBoundingClientRect().bottom;
  return {
    // heading-only slide: from its image to the next visual's title
    headingOnly: Math.round(top(titles[1]) - bottom(imgs[0])),
    // described slide: from its last paragraph to the next visual's title
    afterDescription: Math.round(top(titles[2]) - bottom(titles[2].previousElementSibling)),
    titleStyles: titles.map((t) => t.getAttribute("style")),
    html: document.body.innerHTML,
  };
});
await blank.close();

check("S1  a heading-only slide is followed by a clear gap before the next visual",
  gaps.headingOnly >= 28, `${gaps.headingOnly}px between its image and "Visual 2 of 3"`);
check("S1  …no smaller than the gap after a slide with a description",
  gaps.headingOnly >= gaps.afterDescription - 1,
  `${gaps.headingOnly}px after the heading-only slide, ${gaps.afterDescription}px after the described one`);
check("S2  every visual's title carries the same opening gap",
  gaps.titleStyles.every((s) => /margin-top:\s*2rem/.test(s || "")), JSON.stringify(gaps.titleStyles));
check("S2  the gap is spacing only — no font, size or colour the QA pass would flag",
  !/font-size|font-family|(?:^|[;\s"])color\s*:/i.test(gaps.html));
check("S3  the count still sits inside the title, ahead of it",
  /<h3 tabindex="0"[^>]*><span class="visual-count">Visual 2 of 3: <\/span>Model evaluation<\/h3>/.test(gaps.html));

check("Z  the only 404s are the export's detached /static/ <img> fetches",
  notFound.every((u) => u.startsWith("/static/")), notFound.join(", "));
const realProblems = problems.filter((m) => !/status of 404/.test(m));
check("Z  no other console errors or CSP violations", realProblems.length === 0, realProblems.join(" | "));

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
