// The editor makes nested lists — Indent and Outdent, Tab and Shift+Tab in a
// list item — as valid HTML: the nested list inside the item above it. And
// both prompts put a quotation set apart on the visual in a <blockquote>.
import { launch, makeImage, openWorkspace } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const { b, page, problems } = await launch();
await openWorkspace(page);
await page.setInputFiles("#railFileInput", [
  { name: "List_S1_00-00-01.png", mimeType: "image/png", buffer: await makeImage(page, { w: 400, h: 225, label: "list" }) },
]);
await page.waitForFunction(() => jobs.size === 1 && [...jobs.values()].every((j) => j.base64));

// A description with a list, open in the editor.
const start = (html) => page.evaluate((html) => {
  const j = [...jobs.values()][0];
  if (editMode) commitPendingEdit();
  j.state = "done"; j.resultHtml = html; j.resultText = "x"; j.approved = false;
  renderAll(); selectJob(j.id); toggleEdit(j.id);
}, html);
// The caret in the item whose own text starts with `label`; with `to`, the
// selection runs on to that item.
const caret = (label, to) => page.evaluate(([label, to]) => {
  const preview = els.detailPane.querySelector(".js-preview");
  const textOf = (l) => [...preview.querySelectorAll("li")].map((li) => li.firstChild).find((n) => n && n.nodeType === 3 && n.textContent.startsWith(l));
  const a = textOf(label);
  const z = to ? textOf(to) : a;
  preview.focus();
  window.getSelection().setBaseAndExtent(a, 1, z, 1);
}, [label, to]);
const html = () => page.evaluate(() => els.detailPane.querySelector(".js-preview").innerHTML.replace(/\s+/g, ""));
const tool = (which) => page.click(`#detailPane .js-edit-toolbar [data-list="${which}"]`);

// N1: Tab nests an item under the one above, inside that item.
await start("<ul><li>Alpha</li><li>Beta</li><li>Gamma</li></ul>");
await caret("Beta");
await page.keyboard.press("Tab");
check("N1  Tab nests Beta inside Alpha", (await html()) === "<ul><li>Alpha<ul><li>Beta</li></ul></li><li>Gamma</li></ul>", await html());
await page.keyboard.type("!");
check("N1  and the caret stays in Beta", (await html()).includes("<li>B!eta</li>"), await html());

// N2: Shift+Tab brings it back; the first item does not indent, and Tab
// there leaves the editor rather than being kept.
await page.keyboard.press("Shift+Tab");
check("N2  Shift+Tab outdents it again", (await html()) === "<ul><li>Alpha</li><li>B!eta</li><li>Gamma</li></ul>", await html());
await caret("Alpha");
await page.keyboard.press("Tab");
const n2 = await page.evaluate(() => ({ html: els.detailPane.querySelector(".js-preview").innerHTML.replace(/\s+/g, ""), inEditor: !!document.activeElement?.closest(".js-preview") }));
check("N2  Tab on a first item changes nothing and moves on", n2.html === "<ul><li>Alpha</li><li>B!eta</li><li>Gamma</li></ul>" && !n2.inEditor, JSON.stringify(n2));

// N3: the toolbar's Indent takes a selection of items together, keeps a
// numbered list numbered, and Outdent with items after it keeps the order.
await start("<ol><li>One</li><li>Two</li><li>Three</li><li>Four</li></ol>");
await caret("Two", "Three");
await tool("indent");
check("N3  Indent nests a selection of items, as the same kind of list", (await html()) === "<ol><li>One<ol><li>Two</li><li>Three</li></ol></li><li>Four</li></ol>", await html());
await caret("Two");
await tool("outdent");
check("N3  Outdent keeps the order: the items after it go under it", (await html()) === "<ol><li>One</li><li>Two<ol><li>Three</li></ol></li><li>Four</li></ol>", await html());
await caret("Three");
await page.keyboard.press("Tab").catch(() => {});
const n3 = await html();
check("N3  a first item in a nested list does not indent further", n3 === "<ol><li>One</li><li>Two<ol><li>Three</li></ol></li><li>Four</li></ol>", n3);

// N4: where it cannot, the button says why.
await caret("One");
await tool("indent");
const said = await page.evaluate(() => document.getElementById("statusMessage").textContent);
check("N4  Indent where it can't says what it works on", /after the first in its list/.test(said), said);

// N5: saved, the nested list is kept, and the text reads in order.
await caret("Four");
await tool("indent");
const n5 = await page.evaluate(() => {
  commitPendingEdit();
  const j = [...jobs.values()][0];
  return { html: j.resultHtml.replace(/\s+/g, ""), text: j.resultText.replace(/\n/g, "|") };
});
check("N5  saved, the nested lists stay", n5.html === "<ol><li>One</li><li>Two<ol><li>Three</li><li>Four</li></ol></li></ol>", n5.html);
check("N5  and the text reads in order", n5.text === "One|Two|Three|Four", n5.text);

// Q1: both prompts put a quotation set apart on the visual in a blockquote.
const q1 = await page.evaluate(() => ({ desc: buildSystemPrompt(currentVerbosity()), ocr: buildSystemPrompt(currentVerbosity(), "", true) }));
for (const [name, prompt] of Object.entries(q1)) {
  check(`Q1  the ${name} prompt puts a set-apart quotation in a <blockquote>`, /in quotation marks, in\s+italics, or in a\s+box or callout of its own — goes in a <blockquote>/.test(prompt) && /attribution printed with it/.test(prompt));
}
check("Q1  a blockquote reads as its own block in the text", await page.evaluate(() => {
  const f = sanitizeHtmlFragment("<p>Before</p><blockquote><p>Said.</p></blockquote><p>— Someone</p>");
  return domFragmentToText(f);
}) === "Before\nSaid.\n— Someone", await page.evaluate(() => JSON.stringify(domFragmentToText(sanitizeHtmlFragment("<p>Before</p><blockquote><p>Said.</p></blockquote><p>— Someone</p>")))));

check("Z  no console errors", problems.length === 0, problems.join(" | "));
await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
