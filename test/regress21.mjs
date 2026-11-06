// Segments: each slide is described with the one before it in its segment in
// view, so a graph exported several times as it builds up is described as it
// changes. An identical slide needs no request at all, and a description
// whose previous slide later changes is flagged.
import { launch, makeImage, openWorkspace } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

async function until(page, fn, arg, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const API = "https://api.anthropic.com/v1/messages";
const { b, page, problems } = await launch();

// The API, recording what each request carried and how many were open at once.
const sent = [];
let open = 0;
let maxOpen = 0;
let delay = 300;
await page.route(API, async (route) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const body = JSON.parse(route.request().postData());
  const content = body.messages[0].content;
  const images = content.filter((c) => c.type === "image");
  const texts = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const n = sent.length + 1;
  sent.push({ images: images.length, texts, system: body.system, last: images.length ? images[images.length - 1].source.data.slice(0, 40) : "" });
  open += 1;
  maxOpen = Math.max(maxOpen, open);
  await new Promise((r) => setTimeout(r, delay));
  open -= 1;
  const html = `<h2>Feedbacks Across Models</h2><p>Description ${n}.</p>`;
  return route.fulfill({
    status: 200,
    headers: { ...cors, "content-type": "application/json" },
    body: JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: html }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
  });
});

await openWorkspace(page);
await page.click("#settingsChip");
await page.fill("#apiKey", "sk-ant-test-key");
await page.click("#settingsDone");

const img = (label) => makeImage(page, { w: 400, h: 225, label });
const chart1 = await img("chart");
const chart2 = await img("chart + highlight");
const chart3 = await img("chart + two highlights");
const other = await img("other segment");
const other2 = await img("other segment 2");
const files = [
  { name: "Cronin_S4_00-06-29.png", buffer: chart1 },
  { name: "Cronin_S4_00-07-02.png", buffer: chart2 },
  { name: "Cronin_S4_00-07-15.png", buffer: chart3 },
  { name: "Cronin_S4_00-08-30.png", buffer: chart3 }, // the same image again
  { name: "Atalay_S2_00-01-00.png", buffer: other },
  { name: "Atalay_S2_00-02-00.png", buffer: other2 },
].map((f) => ({ ...f, mimeType: "image/png" }));
await page.setInputFiles("#fileInput", files);
await page.waitForFunction(() => document.querySelectorAll("#railList li").length === 6);
await page.waitForFunction(() => !document.getElementById("describeBtn").disabled, null, { timeout: 5000 });

// ---------- S1: a segment runs in order, each slide with the one before it
await page.click("#describeBtn");
await until(page, () => [...jobs.values()].every((j) => j.state === "done"), null, 20000);
const s1 = await page.evaluate(() => [...jobs.values()].map((j) => ({ name: j.name, html: j.resultHtml, same: !!j.sameAsPrevious, model: j.usedModel })));
check("S1  every slide is described", s1.every((j) => j.html), JSON.stringify(s1.map((j) => j.name)));
check("S1  five requests: the identical slide sends none", sent.length === 5, `${sent.length} requests`);
const byFirst = (data) => sent.find((r) => r.last === data);
const first = sent.find((r) => r.images === 1 && !/PREVIOUS VISUAL/.test(r.system) && r.texts.includes("Describe"));
check("S1  a segment's first slide goes alone, with no previous-visual rules", sent.filter((r) => r.images === 1).length === 2 && !!first);
const withPrev = sent.filter((r) => r.images === 2);
check("S1  every later slide goes with the one before it: two images", withPrev.length === 3, `${withPrev.length} with two images`);
check("S1  with the previous description, and the rules for using it",
  withPrev.every((r) => /ITS DESCRIPTION, already written/.test(r.texts) && /<h2>Feedbacks Across Models<\/h2>/.test(r.texts) && /PREVIOUS VISUAL: The visual shown just before this one/.test(r.system)));
check("S1  the identical slide says so, without a request",
  s1[3].html === "<p>Same as the previous visual.</p>" && s1[3].same && !s1[3].model, JSON.stringify(s1[3]));
check("S1  two segments run side by side, each one slide at a time", maxOpen === 2, `at most ${maxOpen} open`);
const s1meta = await page.evaluate(async () => {
  selectJob([...jobs.values()][3].id);
  await new Promise((r) => setTimeout(r, 50));
  return document.querySelector(".js-slide-meta").textContent;
});
check("S1  the identical slide's pane says it was not sent", /Not sent: the same image as the visual before it/.test(s1meta) && !/sent unmodified/.test(s1meta), s1meta);

// ---------- S2: editing a slide flags the one after it
const flagged = () => page.evaluate(() => [...jobs.values()].map((j) => previousChanged(j)));
check("S2  nothing is flagged straight after a run", (await flagged()).every((f) => !f));
await page.evaluate(() => {
  const j = [...jobs.values()][1];
  j.resultHtml = "<h2>Feedbacks Across Models</h2><p>Edited by hand.</p>";
  renderAll();
});
const s2 = await flagged();
check("S2  editing slide 2 flags slide 3, and only slide 3", s2.join() === "false,false,true,false,false,false", s2.join());
const s2rail = await page.evaluate(() => [...jobs.values()][2].railEl.textContent);
check("S2  its rail row says to check it", /Check: the visual before it changed/.test(s2rail), s2rail.replace(/\s+/g, " ").slice(0, 80));
await page.evaluate(() => selectJob([...jobs.values()][2].id));
const warn = await page.evaluate(() => { const w = document.querySelector(".js-context-warning"); return w && !w.hidden ? w.textContent.trim() : ""; });
check("S2  and its pane says why, with a way to describe it again", /has changed since this description was written/.test(warn));
const before = sent.length;
await page.click(".js-context-redo");
await until(page, (n) => [...jobs.values()][2].state === "done" && !previousChanged([...jobs.values()][2]), null, 10000);
const redo = sent[before];
check("S2  describing it again sends the edited description as the previous one", !!redo && redo.images === 2 && /Edited by hand/.test(redo.texts));
check("S2  and the flag clears", !(await flagged())[2]);

// ---------- S3: the identical slide is flagged when a different slide comes before it
await page.evaluate(() => removeJob([...jobs.values()][2].id));
const s3 = await page.evaluate(() => { const j = [...jobs.values()].find((x) => x.name === "Cronin_S4_00-08-30.png"); return previousChanged(j); });
check("S3  removing the slide an identical one copied flags it", s3 === true);

// ---------- S4: a reload brings no false flags (slide ids are not kept)
await page.evaluate(() => {
  const j = [...jobs.values()].find((x) => x.name === "Cronin_S4_00-08-30.png");
  j.state = "pending"; j.resultHtml = ""; j.resultText = ""; j.contextFrom = null; j.sameAsPrevious = false;
  renderAll();
});
await page.evaluate(() => writeAutosave());
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => typeof jobs !== "undefined" && jobs.size === 5, null, { timeout: 10000 });
const s4 = await page.evaluate(() => [...jobs.values()].map((j) => ({ flag: previousChanged(j), from: !!j.contextFrom })));
// Slides 2 and 5 were described with the slide before them in view; the rest
// are a segment's first, or were reset above.
check("S4  after a reload, descriptions keep what they were written with", s4.map((j) => j.from).join() === "false,true,false,false,true", JSON.stringify(s4));
check("S4  and none is flagged that was not before", s4.every((j) => !j.flag), JSON.stringify(s4));

// ---------- S5: a transcription goes alone
// The key is not kept across a reload, by default.
await page.click("#settingsChip");
await page.fill("#apiKey", "sk-ant-test-key");
await page.click("#settingsDone");
const s5 = await page.evaluate(async () => {
  const list = [...jobs.values()];
  const second = list[1];
  second.textOnly = true;
  return second.id;
});
const n5 = sent.length;
await page.evaluate((id) => refineJob(id, null), s5);
await until(page, (id) => jobs.get(id).state === "done", s5, 10000);
check("S5  a text-only slide is sent alone, with no previous visual", sent.length === n5 + 1 && sent[n5].images === 1 && !/PREVIOUS VISUAL/.test(sent[n5].system));

check("Z  no console errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
