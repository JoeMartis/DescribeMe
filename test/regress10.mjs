// Text & math mode sends a transcription prompt, not a description prompt with
// a rebuttal stapled on. These assert what actually goes on the wire.
import { launch, makeImage, openWorkspace, addFiles, APP_URL } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const { b, page, problems } = await launch();

// Capture every request body so we can read the prompt that was actually sent.
const sent = [];
await page.route("**/v1/messages", async (route) => {
  sent.push(JSON.parse(route.request().postData()));
  await route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      stop_reason: "end_turn", model: "claude-sonnet-5",
      content: [{ type: "text", text: "<h2>Title</h2><p>Body.</p>" }],
    }),
  });
});

await openWorkspace(page);
await page.evaluate(() => {
  const k = document.getElementById("apiKey");
  k.value = "sk-test"; k.dispatchEvent(new Event("input", { bubbles: true }));
});
const png = await makeImage(page, { label: "equations" });

const lastSystem = () => sent[sent.length - 1].system;
const lastUserText = () => sent[sent.length - 1].messages[0].content.find((c) => c.type === "text").text;

// ---------- P1: the two prompts are genuinely different documents
const prompts = await page.evaluate(() => ({
  describe: buildSystemPrompt(VERBOSITY_LEVELS[0], "", false),
  ocr: buildSystemPrompt(VERBOSITY_LEVELS[0], "", true),
  ocrDetailed: buildSystemPrompt(VERBOSITY_LEVELS[2], "", true),
  hasTextOnlyRevision: Object.prototype.hasOwnProperty.call(REVISIONS, "textOnly"),
}));
check("P1  text/math gets its own prompt, not the description one",
  !prompts.ocr.includes("ROLE: You are an accessibility specialist writing extended descriptions"));
check("P1  REVISIONS no longer carries a textOnly override",
  prompts.hasTextOnlyRevision === false);
check("P1  the override wording is gone entirely",
  !prompts.ocr.includes("Override the instructions above"));
check("P1  verbosity does not reach the transcription prompt",
  prompts.ocr === prompts.ocrDetailed && !prompts.ocrDetailed.includes("VERBOSITY"));

// ---------- P2: none of the content-adding rules survive into OCR mode
// Each of these was live in the old build and is a thing authors reported.
const mustNotAppear = [
  ["spell out each symbol on first use", "Spell out each symbol and abbreviation"],
  ["name the figure type first",         "Name the figure type first"],
  ["say what a highlighted term signifies", "what a highlighted term signifies"],
  ["report the trend",                   "then the trend"],
  ["order for teaching, not reading",    "order needed to build understanding"],
  ["instructional takeaway framing",     "instructional takeaway"],
];
for (const [label, needle] of mustNotAppear) {
  check(`P2  transcription prompt drops: ${label}`, !prompts.ocr.includes(needle),
    prompts.ocr.includes(needle) ? "STILL PRESENT" : "");
}
// "A line graph shows" is deliberately quoted in the transcription prompt — as
// the example of an opener NOT to write. A plain substring check cannot tell a
// rule from its prohibition, so assert on the line it sits in.
const graphLine = prompts.ocr.split("\n").find((l) => l.includes("A line graph shows")) || "";
check('P2  "A line graph shows" appears only as a forbidden opener',
  /^- Do not name what kind of thing the image is/.test(graphLine.trim()), graphLine.trim().slice(0, 60));
check('P2  …and as an instruction in the description prompt',
  prompts.describe.split("\n").some((l) => l.includes("A line graph shows") && !/Do not/.test(l)));
check("P2  and the description prompt still has them (they were not deleted globally)",
  mustNotAppear.every(([, needle]) => prompts.describe.includes(needle)));

// ---------- P3: the prompt says the things the mode is for
for (const needle of [
  "This is a transcription, not a description",
  "Do not expand, spell out or define an abbreviation",
  "Reading order, as written",
  "Add no word that is not printed on the image",
]) {
  check(`P3  transcription prompt states: "${needle.slice(0, 44)}…"`, prompts.ocr.includes(needle));
}

// ---------- P4: OCR from the pending pane sends the transcription prompt
await addFiles(page, [{ name: "eq1.png", mimeType: "image/png", buffer: png }]);
await page.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length === 1);
await page.click("#detailPane .js-pending-ocr");
await page.waitForFunction(() => document.getElementById("progressCard").hidden !== false || true);
await page.waitForFunction(() => window.__sentCount === undefined || true);
await page.waitForTimeout(1200);
check("P4  a request was made", sent.length === 1, `sent=${sent.length}`);
check("P4  OCR button sends the transcription prompt",
  lastSystem().startsWith("ROLE: You transcribe the text and mathematics"));
check("P4  and the user turn asks for a transcription, not a description",
  /Transcribe the text and mathematics/.test(lastUserText()) && !/Describe this STEM lecture slide/.test(lastUserText()),
  lastUserText().slice(0, 70));

// ---------- P5: the mode is sticky across a stronger-model redo
await page.click("#detailPane .js-refine-model");
await page.waitForTimeout(1200);
check("P5  Redo with a stronger model keeps transcription mode",
  sent.length === 2 && lastSystem().startsWith("ROLE: You transcribe"), `sent=${sent.length}`);

// ---------- P6: "More detail" leaves the mode and returns to describing
await page.click("#detailPane .js-refine-detail");
await page.waitForTimeout(1200);
check("P6  More detail switches back to the description prompt",
  lastSystem().includes("ROLE: You are an accessibility specialist"), `sent=${sent.length}`);
check("P6  and the user turn switches back too",
  /Describe this STEM lecture slide/.test(lastUserText()));

// ---------- P7: "Text only" from the refine row switches into the mode
await page.click("#detailPane .js-refine-textonly");
await page.waitForTimeout(1200);
check("P7  Text only switches into the transcription prompt",
  lastSystem().startsWith("ROLE: You transcribe"));
check("P7  with no description prompt appended anywhere in it",
  !lastSystem().includes("accessibility specialist writing extended descriptions"));

// ---------- P8: transcript context gets the mode's own framing
const withTranscript = await page.evaluate(() => {
  const job = { textOnly: true, transcriptContext: "the lecturer said Gibbs free energy" };
  const ocr = buildUserText(job);
  const desc = buildUserText({ ...job, textOnly: false });
  return { ocr, desc };
});
check("P8  transcription framing forbids expanding abbreviations",
  /Do not expand abbreviations it expands/.test(withTranscript.ocr));
check("P8  description framing still asks for them to be expanded",
  /expand abbreviations/.test(withTranscript.desc) && !/Do not expand abbreviations/.test(withTranscript.desc));
check("P8  the excerpt itself still rides along in both",
  withTranscript.ocr.includes("Gibbs free energy") && withTranscript.desc.includes("Gibbs free energy"));

// ---------- P9: the settings panel shows both prompts
await page.click("#settingsChip");
await page.waitForTimeout(250);
const preview = await page.textContent("#systemPromptPreview");
check("P9  settings shows the describing prompt", /DESCRIBING A VISUAL/.test(preview));
check("P9  settings shows the text & math prompt", /TEXT & MATH ONLY/.test(preview));
check("P9  and says verbosity does not apply to it", /verbosity does not apply/.test(preview));

check("Z  no console errors or CSP violations", problems.length === 0, problems.join(" | "));

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
