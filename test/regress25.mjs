// Saving through the browser's own Save dialog where it has one, so the
// person picks the folder; a plain download where it has none; and nothing
// at all when they cancel.
import { launch, makeImage, openWorkspace } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const { b, page, problems } = await launch({ acceptDownloads: true, keepSavePicker: true });
// A Save dialog standing in for the browser's: what it was asked, what was
// written, and how it answers (a file, a cancel, or a refusal).
await page.addInitScript(() => {
  window.__save = { asked: [], written: [], answer: "file" };
  window.showSaveFilePicker = async (opts) => {
    window.__save.asked.push(opts);
    if (window.__save.answer === "cancel") throw new DOMException("The user aborted a request.", "AbortError");
    if (window.__save.answer === "refuse") throw new DOMException("Must be handling a user gesture.", "SecurityError");
    const name = `picked-${opts.suggestedName}`;
    return {
      name,
      createWritable: async () => {
        const parts = [];
        return {
          write: async (blob) => parts.push(blob),
          close: async () => window.__save.written.push({ name, size: parts.reduce((n, p) => n + (p.size || 0), 0), type: parts[0]?.type }),
        };
      },
    };
  };
});
await openWorkspace(page);

await page.setInputFiles("#railFileInput", [{ name: "Save_00-00-01.png", mimeType: "image/png", buffer: await makeImage(page, { w: 400, h: 225, label: "save" }) }]);
await page.waitForFunction(() => jobs.size === 1 && [...jobs.values()].every((j) => j.base64));
await page.fill("#batchName", "Cell Biology");
await page.evaluate(() => {
  const [a] = [...jobs.values()];
  a.state = "done"; a.approved = true; a.resultHtml = "<h2>Cell</h2><p>A cell.</p>"; a.resultText = "Cell A cell.";
  renderAll();
});
let downloads = 0;
page.on("download", () => { downloads += 1; });
const status = () => page.$eval("#statusMessage", (e) => e.textContent);

// S1: the zip goes where the person says, not to Downloads.
await page.click("#exportBtn");
await page.waitForFunction(() => window.__save.written.length === 1, null, { timeout: 8000 });
const s1 = await page.evaluate(() => ({ asked: window.__save.asked[0], written: window.__save.written[0] }));
check("S1  Export asks where to save, with a name ready", s1.asked.suggestedName === "Cell-Biology-descriptions.zip" && s1.asked.types[0].accept["application/zip"], JSON.stringify(s1.asked));
check("S1  and writes the zip there", s1.written.size > 100 && downloads === 0, JSON.stringify(s1.written));
check("S1  the status says where it went", /Exported 1 approved description.*Saved as picked-Cell-Biology-descriptions\.zip\./.test(await status()), await status());

// S2: cancelling saves nothing, and says so.
await page.evaluate(() => { window.__save.answer = "cancel"; });
await page.click("#exportBtn");
await page.waitForTimeout(400);
check("S2  a cancelled save writes nothing", (await page.evaluate(() => window.__save.written.length)) === 1 && downloads === 0);
check("S2  and says it was cancelled", /Not exported: the save was cancelled/.test(await status()), await status());

// S3: a dialog the browser refuses falls back to the download.
await page.evaluate(() => { window.__save.answer = "refuse"; });
const dl = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
await page.click("#exportBtn");
const d = await dl;
check("S3  a refused dialog falls back to a download", !!d && d.suggestedFilename() === "Cell-Biology-descriptions.zip", d && d.suggestedFilename());

// S4: a project file is saved the same way.
await page.evaluate(() => { window.__save.answer = "file"; window.__save.asked.length = 0; });
await page.click("#projectsBtn");
await page.click("#saveProjectBtn");
await page.waitForSelector('#projectList button[aria-label="Export project Cell Biology"]');
await page.click('#projectList button[aria-label="Export project Cell Biology"]');
await page.waitForFunction(() => window.__save.written.length === 2, null, { timeout: 8000 });
const s4 = await page.evaluate(() => ({ asked: window.__save.asked[0], written: window.__save.written[1] }));
check("S4  a project file is saved where the person says", s4.asked.suggestedName === "Cell-Biology.describeme.json" && s4.written.size > 100, JSON.stringify(s4));

// S5: and the learner download.
await page.evaluate(() => { els.projectsDialog.close(); return runLearnerDownload("html"); });
await page.waitForFunction(() => window.__save.written.length === 3, null, { timeout: 8000 });
const s5 = await page.evaluate(() => ({ asked: window.__save.asked[window.__save.asked.length - 1], written: window.__save.written[2], status: document.getElementById("learnerStatus")?.textContent || "" }));
check("S5  the learner download is saved where the person says", s5.asked.suggestedName === "Cell-Biology-visual-descriptions.html" && s5.written.type.startsWith("text/html") && /^Saved picked-Cell-Biology-visual-descriptions\.html/.test(s5.status), JSON.stringify(s5));

check("Z  no console errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
