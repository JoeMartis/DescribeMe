// Discuss with Claude: a conversation about one slide's description, with
// what it was written from in view. Revisions are proposed, shown as marked
// changes, and go in only on Use this, undoably, back to needing review.
import { launch, makeImage, openWorkspace } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const API = "https://api.anthropic.com/v1/messages";
const { b, page, problems } = await launch();

// The API: replies come from a queue; every request is recorded.
const sent = [];
const replies = [];
await page.route(API, async (route) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const body = JSON.parse(route.request().postData());
  sent.push(body);
  const next = replies.shift() || { text: "Okay." };
  if (next.status) {
    return route.fulfill({ status: next.status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: next.message || "Bad request" } }) });
  }
  return route.fulfill({
    status: 200,
    headers: { ...cors, "content-type": "application/json" },
    body: JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: next.text }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100 } }),
  });
});

await openWorkspace(page);
await page.click("#settingsChip");
await page.fill("#apiKey", "sk-ant-test-key");
await page.click("#settingsDone");

const img = (label) => makeImage(page, { w: 400, h: 225, label });
await page.setInputFiles("#railFileInput", [
  { name: "Talk_S1_00-00-01.png", mimeType: "image/png", buffer: await img("talk one") },
  { name: "Talk_S1_00-00-02.png", mimeType: "image/png", buffer: await img("talk two") },
]);
await page.waitForFunction(() => jobs.size === 2 && [...jobs.values()].every((j) => j.base64));
await page.evaluate(() => {
  const [a, c] = [...jobs.values()];
  a.state = "done"; a.resultHtml = "<h2>Net Zero</h2><p>A diagram of emissions.</p>"; a.resultText = "Net Zero A diagram of emissions.";
  c.state = "done"; c.resultHtml = "<h2>Net Zero</h2><p>An arrow labeled Sinks leaves the box.</p>"; c.resultText = "Net Zero An arrow labeled Sinks leaves the box.";
  c.transcriptContext = "this box is just the atmosphere";
  c.usedModel = "claude-sonnet-5";
  renderAll();
  selectJob(c.id);
});
const pane = () => page.evaluate(() => {
  const d = els.detailPane;
  const c = [...jobs.values()][1];
  return {
    open: !d.querySelector(".js-discuss").hidden,
    discussing: d.querySelector(".split").classList.contains("discussing"),
    pressed: d.querySelector(".js-discuss-toggle").getAttribute("aria-pressed"),
    sees: d.querySelector(".js-discuss-sees").textContent,
    log: [...d.querySelectorAll(".js-discuss-log > li")].map((li) => li.textContent.replace(/\s+/g, " ").trim()),
    preview: d.querySelector(".js-preview").innerHTML,
    banner: !d.querySelector(".js-proposal-banner").hidden,
    html: c.resultHtml,
    approved: c.approved,
    history: c.history.length,
  };
});

// D1: Discuss opens the panel beside a smaller slide, saying what Claude sees.
await page.click("#detailPane .js-discuss-toggle");
const d1 = await pane();
check("D1  Discuss opens the conversation", d1.open && d1.discussing && d1.pressed === "true", JSON.stringify(d1));
check("D1  it says what Claude sees", /this slide, the slide before it and its description, the transcript around it/.test(d1.sees), d1.sees);

check("D1  with nothing said yet, there is no empty message area", await page.evaluate(() => els.detailPane.querySelector(".js-discuss-log").hidden));
check("D1  focus goes to the message box", await page.evaluate(() => document.activeElement?.classList.contains("js-discuss-input")));
const seesFolded = await page.evaluate(() => els.detailPane.querySelector(".js-discuss-sees").hidden);
await page.click("#detailPane .js-discuss-sees-toggle");
const seesOpen = await page.evaluate(() => ({ hidden: els.detailPane.querySelector(".js-discuss-sees").hidden, expanded: els.detailPane.querySelector(".js-discuss-sees-toggle").getAttribute("aria-expanded") }));
check("D1  folded by default, opened by What Claude sees", seesFolded && !seesOpen.hidden && seesOpen.expanded === "true", JSON.stringify(seesOpen));
await page.click("#detailPane .js-discuss-sees-toggle");
await page.click("#detailPane .js-discuss-input");

// D2: a question gets an answer and changes nothing.
replies.push({ text: "The label on the slide reads that way, so I kept it." });
await page.fill("#detailPane .js-discuss-input", "Why does it say box?");
await page.keyboard.press("Enter");
await page.waitForFunction(() => [...jobs.values()][1].discussion?.length === 2);
const d2 = await pane();
const r1 = sent[sent.length - 1];
const first = r1.messages[0].content;
check("D2  the request carries both slides, the original request, the transcript and the description",
  first.filter((c) => c.type === "image").length === 2 &&
  first.some((c) => c.type === "text" && /THE REQUEST THE DESCRIPTION ANSWERS/.test(c.text) && /this box is just the atmosphere/.test(c.text)) &&
  first.some((c) => c.type === "text" && /THE DESCRIPTION AS IT STANDS NOW/.test(c.text) && /Sinks leaves the box/.test(c.text)) &&
  first.some((c) => c.type === "text" && /Why does it say box\?/.test(c.text)), JSON.stringify(first.map((c) => c.type)));
check("D2  under the description's rules and the discussion's", /DISCUSSING THE DESCRIPTION/.test(r1.system) && /PREVIOUS VISUAL/.test(r1.system) === /PREVIOUS VISUAL/.test(r1.system), r1.system.slice(-80));
check("D2  with the model that wrote it", r1.model === "claude-sonnet-5", r1.model);
check("D2  the answer shows, and the description is untouched", d2.log.some((l) => /label on the slide reads that way/.test(l)) && /Sinks leaves the box/.test(d2.html) && d2.history === 0, JSON.stringify(d2.log));

// D3: a revision is proposed, not applied; its changes can be shown.
replies.push({ text: "Named the atmosphere.\n<revision>\n<h2>Net Zero</h2><p>An arrow labeled Sinks leaves the box, which stands for the atmosphere.</p>\n</revision>" });
await page.fill("#detailPane .js-discuss-input", "She calls it the atmosphere.");
await page.click("#detailPane .js-discuss-send");
await page.waitForFunction(() => [...jobs.values()][1].discussion?.length === 4);
const d3 = await pane();
check("D3  a revision is proposed and nothing changes yet", d3.log.some((l) => /Named the atmosphere\..*Revision 1/.test(l)) && /leaves the box\.<\/p>/.test(d3.html) && d3.history === 0, JSON.stringify(d3.log));
const r2 = sent[sent.length - 1];
check("D3  the conversation so far goes with the next message", r2.messages.length === 3 && r2.messages[1].role === "assistant" && /label on the slide/.test(r2.messages[1].content) && /She calls it the atmosphere/.test(r2.messages[2].content), JSON.stringify(r2.messages.map((m) => m.role)));
const inChat = await page.evaluate(() => els.detailPane.querySelector(".discuss-revision-body")?.innerHTML || "");
check("D3  the revision reads in full in the chat", /which stands for the atmosphere/.test(inChat), inChat);
await page.click("#detailPane .js-discuss-preview");
const previewed = await pane();
check("D3  Preview shows the revision in the description's place, clean", previewed.banner && /which stands for the atmosphere/.test(previewed.preview) && !/<ins>|<del>/.test(previewed.preview) && previewed.history === 0, previewed.preview);
await page.click("#detailPane .js-proposal-switch");
const shown = await pane();
check("D3  Compare marks the changes", shown.banner && /leaves the box<ins>, which stands for the atmosphere<\/ins>\.<\/p>/.test(shown.preview) && shown.history === 0, shown.preview);
await page.click("#detailPane .js-proposal-hide");
check("D3  Back to the description puts it back", !(await pane()).banner && !/<ins>/.test((await pane()).preview));

// D4: Use this puts it in, undoably, needing review again.
await page.evaluate(() => { [...jobs.values()][1].approved = true; renderAll(); });
await page.click("#detailPane .js-discuss-use");
const closed4 = await page.evaluate(() => ({ open: !els.detailPane.querySelector(".js-discuss").hidden, focus: document.activeElement?.classList.contains("js-approve") }));
check("D4  Use this closes the chat and moves to Approve", !closed4.open && closed4.focus, JSON.stringify(closed4));
await page.click("#detailPane .js-discuss-toggle");
const d4 = await pane();
check("D4  Use this puts the revision in the description", /stands for the atmosphere/.test(d4.html) && d4.history === 1, d4.html);
check("D4  and it needs review again", d4.approved === false);
check("D4  the chat says it is in the description", d4.log.some((l) => /Revision 1 is in the description/.test(l)), JSON.stringify(d4.log));
await page.click("#detailPane .js-discuss-undo");
const undone = await pane();
check("D4  Undo in the chat takes it back out", /leaves the box\.<\/p>/.test(undone.html) && undone.history === 0 && undone.log.some((l) => /Revision 1\s*\$[\d.]+\s*Preview\s*Compare\s*Use this/.test(l)), JSON.stringify(undone.log));
await page.click("#detailPane .js-discuss-use");
await page.click("#detailPane .js-discuss-toggle");

// D5: a reply that fails says so, and Try again sends it again.
replies.push({ status: 400, message: "Something was wrong with the request" });
await page.fill("#detailPane .js-discuss-input", "Shorter please.");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelector("#detailPane .discuss-error"));
const d5 = await pane();
check("D5  a failed reply is said, with Try again", d5.log.some((l) => /No reply: .*Something was wrong/.test(l) && /Try again/.test(l)), JSON.stringify(d5.log));
replies.push({ text: "Done.\n<revision><h2>Net Zero</h2><p>Sinks leave the atmosphere.</p></revision>" });
await page.click("#detailPane .js-discuss-retry");
await page.waitForFunction(() => [...jobs.values()][1].discussion?.length === 6);
check("D5  Try again gets the reply", (await pane()).log.some((l) => /Revision 2/.test(l)));

// D6: Shift+Enter is a new line, not a send.
const before6 = sent.length;
await page.click("#detailPane .js-discuss-input");
await page.keyboard.type("line one");
await page.keyboard.press("Shift+Enter");
await page.keyboard.type("line two");
check("D6  Shift+Enter adds a line", sent.length === before6 && (await page.$eval("#detailPane .js-discuss-input", (t) => t.value)) === "line one\nline two");

// D7: the draft survives a redraw; the conversation survives a reload.
await page.evaluate(() => renderAll());
check("D7  an unsent message survives a redraw", (await page.$eval("#detailPane .js-discuss-input", (t) => t.value)) === "line one\nline two");
await page.evaluate(() => writeAutosave());
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => typeof jobs !== "undefined" && jobs.size === 2, null, { timeout: 15000 });
const kept = await page.evaluate(() => { const c = [...jobs.values()][1]; return { n: c.discussion.length, rev: c.discussion.filter((m) => m.revision).length, text: c.resultHtml }; });
check("D7  the conversation comes back after a reload", kept.n === 6 && kept.rev === 2 && /stands for the atmosphere/.test(kept.text), JSON.stringify(kept));

// D8: a conversation from a file is checked like everything else in one.
const d8 = await page.evaluate(() => validDiscussion([
  { role: "user", text: "first" },
  { role: "assistant", text: "x", revision: { html: "<p>ok</p><script>alert(1)</script><img src=x onerror=alert(1)>" } },
  { role: "system", text: "nope" },
  { role: "user", text: 5 },
  { role: "user", text: "fine" },
], (html) => { const f = sanitizeHtmlFragment(html); const h = document.createElement("div"); h.appendChild(f.cloneNode(true)); return { html: h.innerHTML, text: domFragmentToText(f) }; }));
check("D8  a saved conversation is sanitised", d8.length === 3 && !/script|onerror/.test(d8[1].revision.html) && d8[2].text === "fine", JSON.stringify(d8));

// D10: a note Claude writes inside the revision tags goes in the chat, not
// on the course page.
const d10 = await page.evaluate(() => parseDiscussReply("<revision>\nI clarified the rotation.\n<h2>Tree Line</h2><p>The photograph is rotated.</p>\nThat should read better.\n</revision>", false));
check("D10  a note inside the revision is moved to the message", d10.revision.html === "<h2>Tree Line</h2><p>The photograph is rotated.</p>" && /I clarified the rotation\.\s+That should read better\./.test(d10.text), JSON.stringify(d10));
const d10b = await page.evaluate(() => parseDiscussReply("Named it.\n<revision><h2>T</h2><p>Body.</p></revision>", false));
check("D10  a clean revision is left as it is", d10b.revision.html === "<h2>T</h2><p>Body.</p>" && d10b.text === "Named it.", JSON.stringify(d10b));

// D9: Use this from the preview banner.
await page.evaluate(() => { const c = [...jobs.values()][1]; selectJob(c.id); showingProposal = { jobId: c.id, index: 5, mode: "preview" }; renderDetail(); });
await page.click("#detailPane .js-proposal-use");
check("D9  Use this from the preview puts it in", await page.evaluate(() => /Sinks leave the atmosphere/.test([...jobs.values()][1].resultHtml) && !showingProposal));

// D9: a rewritten passage reads as the old, struck, then the new: not
// spliced around the words the two share.
const heavy = await page.evaluate(() => diffHtml(
  "<p>The tree line now appears thicker and closer, filling more of the central vertical band. The pink and orange strip of sky beside the tree line is still present.</p>",
  "<p>The tree line and sky are closer and larger within the frame, with less of the surrounding cloud detail visible than before.</p>"));
check("D9  a rewrite reads as one passage out, one in", (heavy.match(/<del>/g) || []).length <= 2 && (heavy.match(/<ins>/g) || []).length <= 2, heavy);
// D9: removals are marked too, word by word.
const d9a = await page.evaluate(() => diffHtml("<p>A very big box.</p>", "<p>A big red box.</p>"));
check("D9  removed words are struck, added ones underlined", d9a === "<p>A <del>very </del>big <ins>red </ins>box.</p>", d9a);
// D9: marking changes leaves equations alone.
const d9 = await page.evaluate(() => diffHtml("<p><math><mi>x</mi></math></p>", "<p><math><mi>y</mi></math></p>"));
check("D9  no marks inside equations", d9 === null);

// ---------- R1: bug round 1
// R1a: a conversation counts as a change to save.
const r1a = await page.evaluate(() => {
  const c = [...jobs.values()][1];
  const before = batchSignature();
  c.discussion = [...c.discussion, { role: "user", text: "One more thing." }];
  const after = batchSignature();
  c.discussion = c.discussion.slice(0, -1);
  return before !== after;
});
check("R1  a new message counts as a change to save", r1a);

// The reload above dropped the key (it is kept only if asked to be).
await page.evaluate(() => { els.apiKey.value = "sk-ant-test-key"; document.querySelectorAll("dialog[open]").forEach((d) => d.close()); });
// R1b: no approving a revision that is only being previewed.
replies.push({ text: "Try this.\n<revision><h2>Net Zero</h2><p>Previewed only.</p></revision>" });
await page.evaluate(() => { const c = [...jobs.values()][1]; c.approved = false; selectJob(c.id); discussOpen = true; renderDetail(); });
await page.fill("#detailPane .js-discuss-input", "Another go.");
await page.keyboard.press("Enter");
await page.waitForFunction(() => [...jobs.values()][1].discussion.some((m) => m.revision && /Previewed only/.test(m.revision.html)));
await page.evaluate(() => { const c = [...jobs.values()][1]; showingProposal = { jobId: c.id, index: c.discussion.length - 1, mode: "preview" }; renderDetail(); });
const barHidden = await page.evaluate(() => !!els.detailPane.querySelector(".js-approve-bar").hidden);
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("a");
const r1b = await page.evaluate(() => ({ approved: [...jobs.values()][1].approved, status: document.getElementById("statusMessage").textContent }));
check("R1  while previewing, Approve is put away and A approves nothing", barHidden && !r1b.approved && /revision you're looking at/.test(r1b.status), JSON.stringify({ barHidden, ...r1b }));
await page.evaluate(() => { showingProposal = null; renderDetail(); });

// R1c: Try again waits its turn like Send.
const before1c = sent.length;
await page.evaluate(() => {
  discussInFlight = { jobId: "elsewhere", controller: new AbortController() };
  const c = [...jobs.values()][1];
  return requestDiscussionReply(c).then(() => { discussInFlight = null; });
});
check("R1  Try again sends nothing while another reply is coming", sent.length === before1c);

// R1d: Stop ends a reply that is waiting to retry.
replies.push({ status: 503, message: "Overloaded" });
await page.fill("#detailPane .js-discuss-input", "Are you there?");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelector("#detailPane .js-discuss-stop"));
await page.waitForTimeout(150);
const t0 = Date.now();
await page.click("#detailPane .js-discuss-stop");
const stopped = await page.waitForFunction(() => /Stopped/.test(document.querySelector("#detailPane .discuss-error")?.textContent || ""), null, { timeout: 3000 }).then(() => true, () => false);
check("R1  Stop ends a reply waiting to retry, at once", stopped && Date.now() - t0 < 800, `${Date.now() - t0} ms`);

// ---------- R2: bug round 2
// R2a: what Claude says is announced, not only drawn.
replies.push({ text: "The arrows match because the sinks equal the emissions." });
await page.fill("#detailPane .js-discuss-input", "Why equal arrows?");
await page.keyboard.press("Enter");
await page.waitForFunction(() => /^Claude: The arrows match/.test(document.getElementById("statusMessage").textContent), null, { timeout: 8000 }).catch(() => {});
check("R2  a reply is announced in the status line", /^Claude: The arrows match because/.test(await page.$eval("#statusMessage", (e) => e.textContent)), await page.$eval("#statusMessage", (e) => e.textContent));

// R2b: Preview works while the description is open for editing.
const r2b = await page.evaluate(() => {
  const c = [...jobs.values()][1];
  const i = c.discussion.findIndex((m) => m.revision && m.revision.html !== c.resultHtml);
  toggleEdit(c.id);
  els.detailPane.querySelector(`.js-discuss-log > li:nth-child(${i + 1}) .js-discuss-preview`).click();
  return { banner: !els.detailPane.querySelector(".js-proposal-banner").hidden, editing: editMode };
});
check("R2  Preview shows even with the description open for editing", r2b.banner && !r2b.editing, JSON.stringify(r2b));
await page.evaluate(() => { showingProposal = null; renderDetail(); });

// R2c: a removed space leaves no space behind.
check("R2  a removed space is not shown", (await page.evaluate(() => diffHtml("<p>red  box</p>", "<p>red box</p>"))) === "<p>red box</p>");

// ---------- R3: bug round 3
// R3a: focus comes back to the button pressed, not the first of its kind.
const r3a = await page.evaluate(() => {
  const c = [...jobs.values()][1];
  const unused = c.discussion.map((m, i) => (m.revision && m.revision.html !== c.resultHtml ? i : -1)).filter((i) => i >= 0);
  const last = unused[unused.length - 1];
  const btn = els.detailPane.querySelector(`[data-focus-key="compare-${last}"]`);
  btn.focus();
  btn.click();
  return { unused: unused.length, want: `compare-${last}`, got: document.activeElement?.dataset.focusKey };
});
check("R3  focus returns to the very button pressed", r3a.unused >= 2 && r3a.got === r3a.want, JSON.stringify(r3a));
await page.evaluate(() => { showingProposal = null; renderDetail(); });

// R3b: a redraw keeps the conversation where it was scrolled to.
const r3b = await page.evaluate(() => {
  document.activeElement?.blur(); // a focused button is kept in view, rightly
  const log = els.detailPane.querySelector(".js-discuss-log");
  const scrollable = log.scrollHeight > log.clientHeight + 20;
  log.scrollTop = 0;
  renderDetail();
  return { scrollable, top: els.detailPane.querySelector(".js-discuss-log").scrollTop };
});
check("R3  a redraw keeps the conversation's place", r3b.scrollable && r3b.top === 0, JSON.stringify(r3b));

// R3c: a reply to a slide no longer open says which slide it is about.
replies.push({ text: "Still here." });
const r3c = await page.evaluate(async () => {
  const [a, c] = [...jobs.values()];
  c.discussion = [...c.discussion, { role: "user", text: "Still there?" }];
  selectJob(a.id);
  await requestDiscussionReply(c);
  const status = document.getElementById("statusMessage").textContent;
  selectJob(c.id);
  return status;
});
check("R3  a reply about another slide names it", /^Claude \(about Talk_S1_00-00-02\.png\): Still here\./.test(r3c), r3c);

// ---------- R4: bug round 4
// R4a: while a revision is previewed, the tools that act on the description
// are put away; Discuss stays.
const r4a = await page.evaluate(() => {
  const c = [...jobs.values()][1];
  const i = c.discussion.findIndex((m) => m.revision && m.revision.html !== c.resultHtml);
  showingProposal = { jobId: c.id, index: i, mode: "preview" };
  renderDetail();
  const shown = (sel) => { const e = els.detailPane.querySelector(sel); return !!e && !e.hidden && !e.closest("[hidden]"); };
  const out = { edit: shown(".js-edit"), copy: shown(".js-copy-text") || shown(".js-copy-html"), source: shown(".js-source"), discuss: shown(".js-discuss-toggle") };
  showingProposal = null;
  renderDetail();
  out.back = shown(".js-edit") && shown(".js-copy-text") && shown(".js-source");
  return out;
});
check("R4  while previewing, Edit, Copy and the source are put away", !r4a.edit && !r4a.copy && !r4a.source && r4a.discuss && r4a.back, JSON.stringify(r4a));

// R4b: a revision written without the slide before (it had failed) is
// flagged once that slide is described, as a description would be.
replies.push({ text: "Rewritten.\n<revision><h2>Net Zero</h2><p>Written alone.</p></revision>" });
await page.evaluate(() => { const [a] = [...jobs.values()]; a.state = "error"; renderAll(); });
await page.fill("#detailPane .js-discuss-input", "Rewrite it.");
await page.keyboard.press("Enter");
await page.waitForFunction(() => [...jobs.values()][1].discussion.some((m) => m.revision && /Written alone/.test(m.revision.html)));
const r4b = await page.evaluate(() => {
  const [a, c] = [...jobs.values()];
  useRevision(c.id, c.discussion.findIndex((m) => m.revision && /Written alone/.test(m.revision.html)));
  const whileFailed = previousStatus(c);
  a.state = "done";
  renderAll();
  return { whileFailed, missing: !!c.contextFrom?.missing, after: previousStatus(c) };
});
check("R4  a revision written without the slide before is flagged once it is described", r4b.missing && r4b.whileFailed === null && r4b.after === "missing", JSON.stringify(r4b));

// ---------- R5: bug round 5
// R5: during a run, the banner's Use this is disabled and says why if reached.
const r5 = await page.evaluate(() => {
  const c = [...jobs.values()][1];
  const i = c.discussion.findIndex((m) => m.revision && m.revision.html !== c.resultHtml);
  batchRunning = true;
  showingProposal = { jobId: c.id, index: i, mode: "preview" };
  renderDetail();
  const disabled = els.detailPane.querySelector(".js-proposal-use").disabled;
  const before = c.resultHtml;
  useRevision(c.id, i);
  const out = { disabled, unchanged: c.resultHtml === before, status: document.getElementById("statusMessage").textContent };
  batchRunning = false;
  showingProposal = null;
  renderDetail();
  return out;
});
check("R5  during a run, Use this is disabled, and says why", r5.disabled && r5.unchanged && /Wait for the run to finish/.test(r5.status), JSON.stringify(r5));

// ---------- R6: bug round 6
// R6a: approving closes the chat, rather than open it on the next slide.
const r6a = await page.evaluate(() => {
  const c = [...jobs.values()][1];
  selectJob(c.id); discussOpen = true; showingProposal = null; c.approved = false; renderDetail();
  toggleApprove(c.id);
  const out = { approved: c.approved, open: discussOpen };
  c.approved = false; renderAll(); selectJob(c.id);
  return out;
});
check("R6  approving closes the chat", r6a.approved && !r6a.open, JSON.stringify(r6a));

// R6b: Text only is asked under the transcription rules, and using what it
// gives makes the slide a transcription.
replies.push({ text: "Transcribed.\n<revision><p>NET ZERO</p><p>Emissions, Sinks</p></revision>" });
await page.evaluate(() => { discussOpen = true; renderDetail(); });
await page.click("#detailPane .js-discuss-quick[data-mode=\"textOnly\"]");
await page.waitForFunction(() => [...jobs.values()][1].discussion.some((m) => m.revision && /Emissions, Sinks/.test(m.revision.html)));
const r6req = sent[sent.length - 1];
const r6b = await page.evaluate(() => {
  const c = [...jobs.values()][1];
  const i = c.discussion.findIndex((m) => m.revision && /Emissions, Sinks/.test(m.revision.html));
  const before = c.textOnly;
  useRevision(c.id, i);
  return { before, after: c.textOnly, mode: c.discussion[i].mode };
});
check("R6  Text only is asked under the transcription rules", r6req.system.startsWith((await page.evaluate(() => OCR_SYSTEM_PROMPT)).slice(0, 80)), r6req.system.slice(0, 80));
check("R6  using its revision makes the slide a transcription", r6b.before === false && r6b.after === true && r6b.mode === "textOnly", JSON.stringify(r6b));

// ---------- R7: bug round 7
// R7a: the shapes a reply comes back in.
const r7 = await page.evaluate(() => ({
  fenced: parseDiscussReply("Here you go:\n```html\n<revision>\n<h2>T</h2><p>Body.</p>\n</revision>\n```", false),
  two: parseDiscussReply("Two options.\n<revision><h2>A</h2><p>One.</p></revision>\nOr:\n<revision><h2>B</h2><p>Two.</p></revision>", false),
  attrs: parseDiscussReply("Done.\n<revision type=\"html\"><h2>T</h2><p>Attr.</p></revision>", false),
  mentions: parseDiscussReply("I can put a new version between <revision> tags if you like.", false),
  cut: parseDiscussReply("Here it is.\n<revision><h2>T</h2><p>Cut off mid", true),
}));
check("R7  a revision in a code block leaves no fence in the message", r7.fenced.text === "Here you go:" && r7.fenced.revision.html === "<h2>T</h2><p>Body.</p>", JSON.stringify(r7.fenced));
check("R7  a second version is a revision of its own", r7.two.revision.html === "<h2>A</h2><p>One.</p>" && r7.two.text === "Two options." && r7.two.more.length === 1 && r7.two.more[0].text === "Or:" && r7.two.more[0].revision.html === "<h2>B</h2><p>Two.</p>", JSON.stringify(r7.two));
check("R7  a revision tag with attributes is read", r7.attrs.revision?.html === "<h2>T</h2><p>Attr.</p>" && r7.attrs.text === "Done.", JSON.stringify(r7.attrs));
check("R7  a tag only mentioned is just words", r7.mentions.revision === null && /tags if you like\.$/.test(r7.mentions.text), JSON.stringify(r7.mentions));
check("R7  a reply cut off inside a revision offers none", r7.cut.revision === null && r7.cut.text === "Here it is.", JSON.stringify(r7.cut));

// R7b: two versions in one reply become two usable revisions.
replies.push({ text: "Two ways.\n<revision><h2>Net Zero</h2><p>Way one.</p></revision>\nOr:\n<revision><h2>Net Zero</h2><p>Way two.</p></revision>" });
await page.evaluate(() => { discussOpen = true; renderDetail(); });
await page.fill("#detailPane .js-discuss-input", "Give me two.");
await page.keyboard.press("Enter");
await page.waitForFunction(() => [...jobs.values()][1].discussion.some((m) => m.revision && /Way two/.test(m.revision.html)));
const r7b = await page.evaluate(() => {
  const c = [...jobs.values()][1];
  const ones = c.discussion.filter((m) => m.revision && /Way (one|two)/.test(m.revision.html));
  return { n: ones.length, sameView: JSON.stringify(ones[0].contextFrom) === JSON.stringify(ones[1].contextFrom), uses: els.detailPane.querySelectorAll(".js-discuss-use").length >= 2 };
});
check("R7  both versions can be previewed and used", r7b.n === 2 && r7b.sameView && r7b.uses, JSON.stringify(r7b));

// ---------- R8: bug round 8
// R8: while Claude replies about another slide, Send says why it waits, and
// is back as soon as that reply is in.
replies.push({ text: "About slide one." });
const r8 = await page.evaluate(async () => {
  const [a, c] = [...jobs.values()];
  a.discussion = [...(a.discussion || []), { role: "user", text: "And this one?" }];
  selectJob(c.id); discussOpen = true; renderDetail();
  const pending = requestDiscussionReply(a);
  const during = { foot: els.detailPane.querySelector(".js-discuss-foot").textContent, send: els.detailPane.querySelector(".js-discuss-send").disabled };
  await pending;
  const after = { foot: els.detailPane.querySelector(".js-discuss-foot").textContent, send: els.detailPane.querySelector(".js-discuss-send").disabled };
  return { during, after };
});
check("R8  Send says it waits for a reply about another slide", r8.during.send && /Claude is replying about Talk_S1_00-00-01\.png/.test(r8.during.foot), JSON.stringify(r8.during));
check("R8  and is back once that reply is in", !r8.after.send && !/replying about/.test(r8.after.foot), JSON.stringify(r8.after));

// ---------- R9: bug round 9
// R9a: a redraw while typing leaves the cursor where it was.
await page.evaluate(() => { discussOpen = true; renderDetail(); });
await page.click("#detailPane .js-discuss-input");
await page.keyboard.type("first second");
const r9a = await page.evaluate(() => {
  const box = els.detailPane.querySelector(".js-discuss-input");
  box.setSelectionRange(5, 5);
  renderDetail();
  const again = els.detailPane.querySelector(".js-discuss-input");
  return { focused: document.activeElement === again, start: again.selectionStart, end: again.selectionEnd };
});
check("R9  a redraw while typing keeps the cursor in place", r9a.focused && r9a.start === 5 && r9a.end === 5, JSON.stringify(r9a));
await page.evaluate(() => { const box = els.detailPane.querySelector(".js-discuss-input"); box.value = ""; box.dispatchEvent(new Event("input")); });

// R9b: the message box carries what is said under it.
const r9b = await page.evaluate(() => {
  const box = els.detailPane.querySelector(".js-discuss-input");
  const foot = document.getElementById(box.getAttribute("aria-describedby"));
  return foot ? foot.textContent : null;
});
check("R9  the message box is described by the line under it", /Enter sends/.test(r9b || ""), r9b);

// ---------- R10: bug round 10
// R10a: switching to Preview, Compare and back is announced.
const r10a = await page.evaluate(() => {
  const c = [...jobs.values()][1];
  selectJob(c.id); discussOpen = true; showingProposal = null; renderDetail();
  const i = c.discussion.findIndex((m) => m.revision && m.revision.html !== c.resultHtml);
  const said = [];
  els.detailPane.querySelector(`[data-focus-key="preview-${i}"]`).click();
  said.push(document.getElementById("statusMessage").textContent);
  els.detailPane.querySelector(".js-proposal-switch").click();
  said.push(document.getElementById("statusMessage").textContent);
  els.detailPane.querySelector(".js-proposal-hide").click();
  said.push(document.getElementById("statusMessage").textContent);
  return said;
});
check("R10  Preview, Compare and Back are announced", /^Previewing revision \d+/.test(r10a[0]) && /^Comparing revision \d+/.test(r10a[1]) && r10a[2] === "Back to the description.", JSON.stringify(r10a));

// R10b: the rail's move buttons are 24 by 24 at least.
const r10b = await page.evaluate(() => { const r = document.querySelector("#railList .rail-move-btn").getBoundingClientRect(); return { w: r.width, h: r.height }; });
check("R10  the move buttons are at least 24 by 24", r10b.w >= 24 && r10b.h >= 24, JSON.stringify(r10b));

// R10c: on a phone the header's rule is not left on its own.
await page.setViewportSize({ width: 390, height: 800 });
const r10c = await page.evaluate(() => getComputedStyle(document.querySelector(".header-rule")).display);
await page.setViewportSize({ width: 1280, height: 800 });
check("R10  no stray rule in the header on a phone", r10c === "none", r10c);

// ---------- R11: bug round 11
// R11: the chat's model can be stepped up, as Redo with a stronger model can.
await page.evaluate(() => { const c = [...jobs.values()][1]; selectJob(c.id); discussOpen = true; showingProposal = null; renderDetail(); });
const r11opts = await page.evaluate(() => { const s = els.detailPane.querySelector(".js-discuss-model"); return { options: [...s.options].map((o) => o.textContent), value: s.value, label: s.closest("label")?.textContent.trim() }; });
check("R11  the chat offers each model, starting from the one that wrote it", r11opts.options.join() === "Haiku 4.5,Sonnet 5,Opus 5" && r11opts.value === "claude-sonnet-5" && /^Model/.test(r11opts.label), JSON.stringify(r11opts));
await page.selectOption("#detailPane .js-discuss-model", "claude-opus-5");
replies.push({ text: "Opus here." });
await page.fill("#detailPane .js-discuss-input", "A second opinion?");
await page.keyboard.press("Enter");
await page.waitForFunction(() => [...jobs.values()][1].discussion.some((m) => m.text === "Opus here."));
check("R11  and the next reply comes from the model picked", sent[sent.length - 1].model === "claude-opus-5", sent[sent.length - 1].model);
check("R11  the pick stays for that slide", await page.evaluate(() => els.detailPane.querySelector(".js-discuss-model").value === "claude-opus-5"));

// ---------- R13: bug round 13 (an independent review)
// R13a: a menu stays open when a click sends focus nowhere (Safari and
// Firefox on macOS give a clicked button no focus); a click elsewhere closes it.
const r13a = await page.evaluate(() => {
  const c = [...jobs.values()][1];
  selectJob(c.id); renderDetail();
  els.detailPane.querySelector(".js-more").click();
  document.activeElement.blur(); // focus to nowhere, as such a click does
  const stillOpen = !els.detailPane.querySelector(".js-more-menu").hidden;
  document.body.click();
  const closedByClick = els.detailPane.querySelector(".js-more-menu").hidden;
  els.railAddBtn.click();
  document.activeElement.blur();
  const railOpen = !els.railAddMenu.hidden;
  document.body.click();
  return { stillOpen, closedByClick, railOpen, railClosed: els.railAddMenu.hidden };
});
check("R13  a menu survives a click that sends focus nowhere, and closes on one elsewhere", r13a.stillOpen && r13a.closedByClick && r13a.railOpen && r13a.railClosed, JSON.stringify(r13a));

// R13b: Discuss works with the description open for editing.
const r13b = await page.evaluate(() => {
  const c = [...jobs.values()][1];
  discussOpen = false; renderDetail();
  toggleEdit(c.id);
  els.detailPane.querySelector(".js-discuss-toggle").click();
  return { open: discussOpen, shown: !els.detailPane.querySelector(".js-discuss").hidden, editing: editMode };
});
check("R13  Discuss opens even mid-edit", r13b.open && r13b.shown && !r13b.editing, JSON.stringify(r13b));

// R13e: the mode asked for decides whether the slide before is sent.
const r13e = await page.evaluate(() => {
  const c = [...jobs.values()][1]; // the slide before it is described
  const keep = { textOnly: c.textOnly, discussion: c.discussion };
  c.textOnly = false;
  c.discussion = [{ role: "user", text: "Text only.", mode: "textOnly" }];
  const asText = discussionRequest(c);
  c.textOnly = true;
  c.discussion = [{ role: "user", text: "More detail.", mode: "more" }];
  const asMore = discussionRequest(c);
  Object.assign(c, keep);
  const images = (r) => r.messages[0].content.filter((x) => x.type === "image").length;
  return { textImages: images(asText), textCtx: !!asText.context, textMode: asText.textOnly, moreMode: asMore.textOnly };
});
check("R13  Text only is asked without the slide before; More detail as a description", r13e.textImages === 1 && !r13e.textCtx && r13e.textMode === true && r13e.moreMode === false, JSON.stringify(r13e));

// R13c: removing a slide whose reply is coming cancels it; the rest can send.
replies.push({ status: 503, message: "Overloaded" });
const r13c = await page.evaluate(async () => {
  const [a, c] = [...jobs.values()];
  a.discussion = [...(a.discussion || []), { role: "user", text: "Busy?" }];
  const pending = requestDiscussionReply(a);
  await new Promise((r) => setTimeout(r, 200));
  const during = !!discussInFlight;
  removeJob(a.id);
  // Straight away: waited out, the retry's backoff would end it anyway.
  await new Promise((r) => setTimeout(r, 150));
  const cancelled = !discussInFlight;
  await pending;
  selectJob(c.id); discussOpen = true; renderDetail();
  return { during, cancelled, after: !!discussInFlight, send: els.detailPane.querySelector(".js-discuss-send").disabled };
});
check("R13  removing the slide cancels its reply, and Send is free again", r13c.during && r13c.cancelled && !r13c.after && !r13c.send, JSON.stringify(r13c));

// R13d: no "..": a folder of that name cannot climb out of the zip.
const r13d = await page.evaluate(() => [safeFileStem("..folder", new Set()), safeFileStem("..", new Set()), safeFileStem("UCE.3_L2.folder", new Set())]);
check("R13  no file or folder named '..'", !r13d.slice(0, 2).some((x) => /^\.|\.$/.test(x)) && r13d[2] === "UCE.3_L2", JSON.stringify(r13d));

// R13f: a conversation cut short on loading starts with a person's message.
const r13f = await page.evaluate(() => validDiscussion([{ role: "assistant", text: "orphan reply" }, { role: "user", text: "hi" }, { role: "assistant", text: "hello" }], (h) => ({ html: h, text: h })).map((m) => m.role).join());
check("R13  a loaded conversation starts with the person", r13f === "user,assistant", r13f);

check("Z  no console errors", problems.filter((m) => !/400|503|Bad Request|Service Unavailable/i.test(m)).length === 0, problems.join(" | "));
await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
