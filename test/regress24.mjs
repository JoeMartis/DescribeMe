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
const d4 = await pane();
check("D4  Use this puts the revision in the description", /stands for the atmosphere/.test(d4.html) && d4.history === 1, d4.html);
check("D4  and it needs review again", d4.approved === false);
check("D4  the chat says it is in the description", d4.log.some((l) => /Revision 1 is in the description/.test(l)), JSON.stringify(d4.log));
await page.click("#detailPane .js-discuss-undo");
const undone = await pane();
check("D4  Undo in the chat takes it back out", /leaves the box\.<\/p>/.test(undone.html) && undone.history === 0 && undone.log.some((l) => /Revision 1\s*\$[\d.]+\s*Preview\s*Compare\s*Use this/.test(l)), JSON.stringify(undone.log));
await page.click("#detailPane .js-discuss-use");

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
  { role: "assistant", text: "x", revision: { html: "<p>ok</p><script>alert(1)</script><img src=x onerror=alert(1)>" } },
  { role: "system", text: "nope" },
  { role: "user", text: 5 },
  { role: "user", text: "fine" },
], (html) => { const f = sanitizeHtmlFragment(html); const h = document.createElement("div"); h.appendChild(f.cloneNode(true)); return { html: h.innerHTML, text: domFragmentToText(f) }; }));
check("D8  a saved conversation is sanitised", d8.length === 2 && !/script|onerror/.test(d8[0].revision.html) && d8[1].text === "fine", JSON.stringify(d8));

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

check("Z  no console errors", problems.filter((m) => !/400|Bad Request/i.test(m)).length === 0, problems.join(" | "));
await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
