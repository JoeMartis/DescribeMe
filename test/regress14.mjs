// The four things the accessibility team asked for on 30 Sep: a Save button
// where work gets cleared, a labelled Projects button, and filenames you can
// actually read — in the rail and in the Projects dialog.
import { launch, makeImage, openWorkspace, addFiles } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const { b, page, problems } = await launch();

// fixtures' own handler accepts the dialog; this one only records what it
// said, so the confirm text can be asserted on.
const confirms = [];
page.on("dialog", (d) => confirms.push(d.message()));

await openWorkspace(page);

const png = await makeImage(page, { label: "s" });
// The real shape of these uploads: a long shared prefix, and the only thing
// telling one from another sitting at the very end.
const NAMES = [
  "M3_ASSIGNMENT_EXPLANATION_01.png",
  "M3_ASSIGNMENT_EXPLANATION_02.png",
  "M3_ASSIGNMENT_EXPLANATION_10.png",
];

const railSave = () => page.evaluate(() => {
  const btn = document.getElementById("railSaveBtn");
  return { label: btn.textContent, hidden: btn.hidden, disabled: btn.disabled, aria: btn.getAttribute("aria-label") };
});

// ---------- N1: the Save button appears with the batch it protects
let s = await railSave();
check("N1  no Save button before there is anything to save", s.hidden, `hidden=${s.hidden}`);

await addFiles(page, NAMES.map((name) => ({ name, mimeType: "image/png", buffer: png })));
await page.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length === 3);
await page.waitForTimeout(300);

s = await railSave();
check("N1  it appears once there are slides", !s.hidden && s.label === "Save", `${s.label}, hidden=${s.hidden}`);
check("N1  it sits before New batch, in the order the two are used",
  await page.evaluate(() => {
    const kids = [...document.querySelector(".rail-head-actions").children];
    return kids.indexOf(document.getElementById("railSaveBtn")) <
           kids.indexOf(document.getElementById("newBatchBtn"));
  }));

// ---------- N2: filenames are legible without hovering
// The ask was for a hover or magnifier. The text column is ~150px, about 16
// characters, so a tooltip alone would still leave every row reading the
// same — the name gets two lines instead.
const rail = await page.evaluate(() =>
  [...document.querySelectorAll("#railList .rail-name")].map((n) => ({
    text: n.textContent,
    title: n.title,
    clipped: n.scrollHeight > n.clientHeight + 1,
  })));
check("N2  the rail shows each filename in full, with no hover",
  rail.every((r, i) => r.text === NAMES[i] && !r.clipped),
  rail.map((r) => r.text + (r.clipped ? " (CLIPPED)" : "")).join(" / "));
check("N2  the part that tells them apart is visible",
  rail.map((r) => r.text.slice(-7)).join(",") === "_01.png,_02.png,_10.png",
  rail.map((r) => r.text.slice(-7)).join(","));
check("N2  hover still carries the full name", rail.every((r, i) => r.title === NAMES[i]));
check("N2  and so does the row's accessible name, for anyone who cannot hover",
  await page.evaluate((n) =>
    document.querySelector("#railList .rail-row").getAttribute("aria-label").startsWith(n), NAMES[0]));

// ---------- N3: saving works from the rail, without opening the dialog
await page.fill("#batchName", "UCE_MODELING_AND_SIMULATION_WEEK_04_FINAL");
await page.evaluate(() => document.getElementById("batchName").dispatchEvent(new Event("input", { bubbles: true })));
await page.waitForTimeout(150);
await page.click("#railSaveBtn");
await page.waitForTimeout(600);

check("N3  the Projects dialog stayed shut", await page.evaluate(() => !document.getElementById("projectsDialog").open));
check("N3  the workspace says it saved",
  /UCE_MODELING_AND_SIMULATION_WEEK_04_FINAL.*saved/.test(await page.textContent("#statusMessage")),
  (await page.textContent("#statusMessage")).trim());
s = await railSave();
check("N3  the button now reads Saved", s.label === "Saved", s.label);
check("N3  and says so in its accessible name, not only in colour",
  /already saved/.test(s.aria), s.aria);
check("N3  it stays enabled, so saving again can update the project", !s.disabled);

// ---------- N4: "Saved" survives the next render
// renderAll() calls markDirty() on every render, so a flag cleared there
// would be wiped by the very render that had just drawn "Saved". This is
// that regression: nothing about the batch changed, so it is still saved.
await page.evaluate(() => renderAll());
await page.waitForTimeout(150);
s = await railSave();
check("N4  a render that changes nothing does not un-save the batch", s.label === "Saved", s.label);

// ---------- N5: a real change flips it back
await page.evaluate(() => [...document.querySelectorAll("#railList .rail-row")][0].click());
await page.waitForTimeout(200);
await page.click(".js-move-down"); // reorder — a change a save would capture
await page.waitForTimeout(300);
s = await railSave();
check("N5  changing the batch flips it back to Save", s.label === "Save", s.label);

// ---------- N6: New batch tells the truth about what is at risk
confirms.length = 0;
await page.click("#newBatchBtn");
await page.waitForTimeout(400);
check("N6  an unsaved change is named as unsaved",
  /have NOT been saved|clears the 3 queued slides/.test(confirms[0] || ""), confirms[0]);
check("N6  the batch was cleared", await page.evaluate(() => document.querySelectorAll("#railList .rail-row").length === 0));

// Saved batch, then New batch again: the warning must not cry wolf.
await addFiles(page, NAMES.map((name) => ({ name, mimeType: "image/png", buffer: png })));
await page.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length === 3);
await page.fill("#batchName", "SAFE_TO_CLEAR");
await page.evaluate(() => document.getElementById("batchName").dispatchEvent(new Event("input", { bubbles: true })));
await page.waitForTimeout(150);
await page.click("#railSaveBtn");
await page.waitForTimeout(600);
confirms.length = 0;
await page.click("#newBatchBtn");
await page.waitForTimeout(400);
check("N6  a saved batch is described as reopenable, not as about to be lost",
  /is saved, so you can reopen it/.test(confirms[0] || ""), confirms[0]);

// ---------- N7: the Projects button says what it is
const projectsBtn = await page.evaluate(() => {
  const btn = document.getElementById("projectsBtn");
  const svg = btn.querySelector("svg").getBoundingClientRect();
  return { text: btn.textContent.trim(), icon: Math.round(svg.width), iconOnly: btn.classList.contains("btn-icon") };
});
check("N7  the folder button carries a visible label", projectsBtn.text === "Projects", projectsBtn.text);
check("N7  it is no longer an icon-only button", !projectsBtn.iconOnly);
check("N7  the icon is the larger size", projectsBtn.icon >= 19, `${projectsBtn.icon}px`);

// ---------- N8: the Projects dialog shows full names, no hover
// Three saves of one long name is the case that matters: truncated, they are
// indistinguishable, and picking the wrong one loses work.
await page.click("#projectsBtn");
await page.waitForTimeout(500);
const names = await page.evaluate(() =>
  [...document.querySelectorAll(".project-name")].map((n) => ({
    text: n.textContent,
    clipped: n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1,
  })));
check("N8  saved projects are listed", names.length >= 2, `${names.length} rows`);
check("N8  every name is shown in full, with nothing truncated",
  names.every((n) => !n.clipped && !/…/.test(n.text)),
  names.map((n) => n.text).join(" / "));
check("N8  including the long one the team flagged",
  names.some((n) => n.text === "UCE_MODELING_AND_SIMULATION_WEEK_04_FINAL"),
  names.map((n) => n.text).join(" / "));

check("Z  no console errors or CSP violations", problems.length === 0, problems.join(" | "));

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
