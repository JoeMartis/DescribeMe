// Refine choices must not leak between slides. Every "Not quite right?" action
// is scoped to the slide it was pressed on — these read the next slide's
// request off the wire to prove it.
import { launch, makeImage, openWorkspace, addFiles } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const { b, page, problems } = await launch();

const sent = [];
await page.route("**/v1/messages", async (route) => {
  const body = JSON.parse(route.request().postData());
  sent.push(body);
  await route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      stop_reason: "end_turn", model: body.model,
      content: [{ type: "text", text: "<h2>Title</h2><p>Body text here.</p>" }],
    }),
  });
});

await openWorkspace(page);
await page.evaluate(() => {
  const k = document.getElementById("apiKey");
  k.value = "sk-test"; k.dispatchEvent(new Event("input", { bubbles: true }));
  document.getElementById("model").value = "claude-sonnet-5";
});

const png = await makeImage(page, { label: "s" });
await addFiles(page, [
  { name: "a.png", mimeType: "image/png", buffer: png },
  { name: "b.png", mimeType: "image/png", buffer: png },
]);
await page.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length === 2);

const select = async (i) => {
  await page.evaluate((n) => [...document.querySelectorAll("#railList .rail-row")][n].click(), i);
  await page.waitForTimeout(250);
};
const last = () => sent[sent.length - 1];
const isOcr = (r) => r.system.startsWith("ROLE: You transcribe");
const revisionIn = (r) => {
  const m = r.system.match(/REVISION: [^\n]*/);
  return m ? m[0].slice(0, 46) : null;
};
const describeSelected = async () => {
  const before = sent.length;
  await page.click("#detailPane .js-pending-primary");
  await page.waitForFunction((n) => true, before);
  await page.waitForTimeout(1200);
};

// Describe slide 1 normally so its refine card appears.
await select(0);
await describeSelected();
check("R0  slide 1 described with the description prompt", !isOcr(last()) && !revisionIn(last()));
check("R0  on the model from the picker", last().model === "claude-sonnet-5", last().model);

// ---------- R1: Text only on slide 1 does not follow to slide 2
await select(0);
await page.click("#detailPane .js-refine-textonly");
await page.waitForTimeout(1200);
check("R1  slide 1 switched to transcription", isOcr(last()));

await select(1);
await describeSelected();
check("R1  slide 2 is NOT in transcription mode", !isOcr(last()),
  isOcr(last()) ? "LEAKED — slide 2 got the OCR prompt" : "");
check("R1  slide 2's user turn asks for a description",
  /Describe this STEM lecture slide/.test(last().messages[0].content.find((c) => c.type === "text").text));

// ---------- R2: Shorter on slide 2 does not follow back to slide 1
await select(1);
await page.click("#detailPane .js-refine-short");
await page.waitForTimeout(1200);
check("R2  slide 2 got the Shorter revision", /longer than it needed/.test(last().system));

await select(0);
await page.click("#detailPane .js-refine-detail"); // More detail on slide 1
await page.waitForTimeout(1200);
check("R2  slide 1 carries More detail, not slide 2's Shorter",
  /too sparse/.test(last().system) && !/longer than it needed/.test(last().system),
  revisionIn(last()) || "none");

// ---------- R3: "Redo with a stronger model" is a one-off, not a new default
await select(0);
const modelBtn = await page.$("#detailPane .js-refine-model");
if (modelBtn && !(await modelBtn.isHidden())) {
  await modelBtn.click();
  await page.waitForTimeout(1200);
  const stronger = last().model;
  check("R3  the redo used a stronger model", stronger !== "claude-sonnet-5", stronger);
  check("R3  the picker itself was NOT changed",
    (await page.$eval("#model", (e) => e.value)) === "claude-sonnet-5",
    await page.$eval("#model", (e) => e.value));

  // A fresh slide must still use the picker, not the stronger model.
  await addFiles(page, [{ name: "c.png", mimeType: "image/png", buffer: png }]);
  await page.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length === 3);
  await select(2);
  await describeSelected();
  check("R3  a new slide uses the picker's model, not the stronger one",
    last().model === "claude-sonnet-5", last().model);
} else {
  check("R3  stronger-model button unavailable (already top of ladder) — skipped", true);
}

// ---------- R4: a batch run after refining uses the picker and no revision,
// and a per-slide transcription mode reaches exactly the slide it is set on.
await select(1);
await page.click("#detailPane .js-refine-textonly"); // slide 2 into transcription
await page.waitForTimeout(1200);
check("R4  slide 2 set to transcription before the batch", isOcr(last()));

await page.evaluate(() => {
  // Put every slide back to pending so Describe all has something to run.
  // job.textOnly is deliberately untouched — it is the thing under test.
  jobs.forEach((j) => { j.state = "pending"; j.resultHtml = ""; j.resultText = ""; j.approved = false; });
  renderAll();
});
await page.waitForTimeout(300);
const beforeBatch = sent.length;
await page.click("#describeBtn");
await page.waitForFunction(() => document.getElementById("progressCard").hidden, null, { timeout: 20000 });
await page.waitForTimeout(500);
const batch = sent.slice(beforeBatch);
check("R4  the batch ran every slide", batch.length === 3, `${batch.length} requests`);
check("R4  no slide in the batch carried a revision",
  batch.every((r) => !revisionIn(r)), batch.map(revisionIn).filter(Boolean).join(" | "));
check("R4  every slide in the batch used the picker's model",
  batch.every((r) => r.model === "claude-sonnet-5"), [...new Set(batch.map((r) => r.model))].join(", "));

// Transcription mode IS meant to persist — on its own slide, and only there.
// Assert on the batch's actual requests, not on the flags: exactly one slide
// was set to transcription, so exactly one request may carry that prompt.
const ocrInBatch = batch.filter(isOcr).length;
check("R4  exactly one slide in the batch used the transcription prompt",
  ocrInBatch === 1, `${ocrInBatch} of ${batch.length}`);
check("R4  the other slides in the batch got the description prompt",
  batch.filter((r) => !isOcr(r)).length === batch.length - 1);

check("Z  no console errors or CSP violations", problems.length === 0, problems.join(" | "));

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
