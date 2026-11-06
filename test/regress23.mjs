// The slide pane, calmer: one big button at a time (Approve while a slide
// needs it, and Export only while none does), the file name once, the
// everyday actions as quiet text buttons under the description, and Remove
// from batch out of the way in a ⋯ menu.
import { launch, makeImage, openWorkspace } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const { b, page, problems } = await launch();
await openWorkspace(page);
await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});

const img = (label) => makeImage(page, { w: 400, h: 225, label });
await page.setInputFiles("#railFileInput", [
  { name: "Pane_S1_00-00-01.png", mimeType: "image/png", buffer: await img("pane one") },
  { name: "Pane_S1_00-00-02.png", mimeType: "image/png", buffer: await img("pane two") },
]);
await page.waitForFunction(() => jobs.size === 2 && [...jobs.values()].every((j) => j.base64));
await page.evaluate(() => {
  for (const [i, j] of [...jobs.values()].entries()) {
    j.state = "done";
    j.resultHtml = `<h2>Pane</h2><p>Description ${i + 1}.</p>`;
    j.resultText = `Pane Description ${i + 1}.`;
  }
  renderAll();
  selectJob([...jobs.keys()][0]);
});

const pane = () => page.evaluate(() => {
  const d = els.detailPane;
  const vis = (sel) => { const e = d.querySelector(sel); return !!e && !e.closest("[hidden]") && e.getClientRects().length > 0; };
  return {
    place: d.querySelector(".js-kicker").textContent,
    name: d.querySelector(".js-pane-name").textContent,
    shared: d.querySelector(".js-pane-name .rail-name-shared")?.textContent || "",
    bar: vis(".js-approve-bar"),
    approveInStatus: !!d.querySelector(".js-status-actions .js-approve"),
    approveLabel: d.querySelector(".js-approve-label").textContent,
    removeVisible: vis(".js-remove"),
    actionsAfterDesc: !!d.querySelector(".js-desc ~ .js-desc-actions"),
    exportPrimary: els.exportBtn.classList.contains("btn-primary"),
  };
});

// P1: where the slide is, and its name once.
const p1 = await pane();
check("P1  the pane says where the slide is", p1.place === "Slide 1 of 2", p1.place);
check("P1  and its file name once, the shared part quiet", p1.name === "Pane_S1_00-00-01.png" && p1.shared === "Pane_S1_", JSON.stringify(p1));
check("P1  the everyday actions sit under the description", p1.actionsAfterDesc);

// P2: a slide to review: Approve is the big button, and Export steps back.
check("P2  Approve is at the foot while the slide needs it", p1.bar && !p1.approveInStatus && p1.approveLabel === "Approve & next", JSON.stringify(p1));
check("P2  Export is not red meanwhile", !p1.exportPrimary);

// P3: approved: the button goes up beside the tag as Un-approve.
await page.evaluate(() => { const j = [...jobs.values()][0]; j.approved = true; selectJob(j.id); });
const p3 = await pane();
check("P3  approved, the foot bar goes and Un-approve sits in the status row", !p3.bar && p3.approveInStatus && p3.approveLabel === "Un-approve", JSON.stringify(p3));
check("P3  with nothing waiting on this slide, Export is red", p3.exportPrimary);
await page.click("#detailPane .js-status-actions .js-approve");
check("P3  Un-approve still un-approves", await page.evaluate(() => ![...jobs.values()][0].approved));

// P4: Remove from batch is in the ⋯ menu.
await page.evaluate(() => selectJob([...jobs.keys()][1]));
check("P4  Remove is not on show", !(await pane()).removeVisible);
await page.click("#detailPane .js-more");
const opened = await page.evaluate(() => ({ expanded: els.detailPane.querySelector(".js-more").getAttribute("aria-expanded"), focus: document.activeElement?.classList.contains("js-remove") }));
check("P4  ⋯ opens the menu, focus on Remove", opened.expanded === "true" && opened.focus, JSON.stringify(opened));
await page.keyboard.press("Escape");
const closed = await page.evaluate(() => ({ hidden: els.detailPane.querySelector(".js-more-menu").hidden, focus: document.activeElement?.classList.contains("js-more") }));
check("P4  Escape closes it and returns to ⋯", closed.hidden && closed.focus, JSON.stringify(closed));
await page.click("#detailPane .js-more");
await page.click("#detailPane .js-remove");
check("P4  Remove from batch removes the slide", await page.evaluate(() => jobs.size === 1));

// P5: Copy keeps its icon after saying Copied!
await page.click("#detailPane .js-copy-text");
await page.waitForTimeout(100);
const copied = await page.evaluate(() => { const btn = els.detailPane.querySelector(".js-copy-text"); return { text: btn.textContent.trim(), svg: !!btn.querySelector("svg") }; });
check("P5  Copy says Copied! and keeps its icon", copied.text === "Copied!" && copied.svg, JSON.stringify(copied));

check("Z  no console errors", problems.length === 0, problems.join(" | "));
await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
