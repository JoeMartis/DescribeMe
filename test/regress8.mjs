// Writing a description by hand, without sending the image to Claude.
import { launch, makeImage, openWorkspace, addFiles } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const { b, page, problems } = await launch();

// Any request to the API is a failure of the whole premise — count them.
let apiCalls = 0;
await page.route("**/v1/messages", async (route) => {
  apiCalls += 1;
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      stop_reason: "end_turn",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: "<h2>Model wrote this</h2><p>From the model.</p>" }],
    }),
  });
});

await openWorkspace(page);
const png = await makeImage(page, { label: "regression" });
await addFiles(page, [
  { name: "M1_L1_S1.png", mimeType: "image/png", buffer: png },
  { name: "M1_L1_S2.png", mimeType: "image/png", buffer: png },
]);
await page.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length === 2);

const detail = () => page.evaluate(() => {
  const q = (s) => document.querySelector(`#detailPane ${s}`);
  const vis = (s) => { const el = q(s); return !!el && !el.hidden && el.offsetParent !== null; };
  return {
    writeVisible: vis(".js-pending-write"),
    pendingVisible: vis(".js-pending"),
    descVisible: vis(".js-desc"),
    tag: q(".js-tag")?.textContent || "",
    descMeta: q(".js-desc-meta")?.textContent || "",
    editLabel: q(".js-edit-label")?.textContent || "",
    refineTitle: q(".js-refine-title")?.textContent || "",
    refineStd: vis(".js-refine-actions"),
    refineAuthored: vis(".js-refine-authored"),
    railText: document.querySelector('#railList .rail-row[aria-current="true"]')?.textContent || "",
    status: document.getElementById("statusMessage")?.textContent || "",
  };
});
const selected = () => page.evaluate(() => document.querySelector('#railList .rail-row[aria-current="true"]')?.textContent || "");

// ---- W1: the button is offered on a not-yet-described slide
let d = await detail();
check("W1  a not-yet-described slide offers Write description", d.writeVisible && d.pendingVisible, JSON.stringify(d));
check("W1  its label says what it does", await page.textContent("#detailPane .js-pending-write") === "Write description");

// ---- W2: it opens the editor, sends nothing, and says so
await page.click("#detailPane .js-pending-write");
await page.waitForTimeout(200);
d = await detail();
check("W2  the description pane opens", d.descVisible && !d.pendingVisible, JSON.stringify(d));
check("W2  the editor is live and focused", await page.evaluate(() =>
  document.querySelector("#detailPane .js-preview")?.getAttribute("contenteditable") === "true" &&
  document.activeElement === document.querySelector("#detailPane .js-preview")));
check("W2  the button now offers to save", d.editLabel === "Save changes", d.editLabel);
check("W2  nothing was sent to the API", apiCalls === 0, `apiCalls=${apiCalls}`);
check("W2  and it says so", /Nothing is sent to Claude/i.test(d.status), d.status);
check("W2  the rail says it is being written, not described", /Writing/.test(d.railText), d.railText);

// ---- W3: typed text saves through the normal edit path
await page.click("#detailPane .js-preview");
await page.keyboard.type("Bar chart of enrolment by term.");
await page.click("#detailPane .js-edit");
await page.waitForTimeout(200);
d = await detail();
check("W3  the description saved", /enrolment by term/.test(await page.textContent("#detailPane .js-preview")));
check("W3  it is credited to the person, not the model", /written by you/.test(d.descMeta) && !/edited by you/.test(d.descMeta), d.descMeta);
check("W3  the slide meta says no request was made", /Not sent to Claude/.test(await page.textContent("#detailPane .js-slide-meta")), await page.textContent("#detailPane .js-slide-meta"));
check("W3  no model or duration is claimed", !/Sonnet|Opus|Haiku|\ds\b/.test(await page.textContent("#detailPane .js-slide-meta")), await page.textContent("#detailPane .js-slide-meta"));
check("W3  the rail stops saying it is being written", /Written by you/.test(d.railText) && !/Writing/.test(d.railText), d.railText.replace(/\s+/g, " ").trim());
check("W3  the tag reads as unapproved, not unreviewed", d.tag === "Not approved yet", d.tag);
check("W3  still nothing sent", apiCalls === 0, `apiCalls=${apiCalls}`);

// ---- W4: refine is replaced by the one thing it could honestly offer
check("W4  the refine buttons are hidden", !d.refineStd, JSON.stringify(d));
check("W4  a single Claude option is offered instead", d.refineAuthored, JSON.stringify(d));
check("W4  under a heading that fits", /Rather have Claude/.test(d.refineTitle), d.refineTitle);

// ---- W5: it approves and exports like any other description
await page.click("#detailPane .js-approve");
await page.waitForTimeout(250);
check("W5  a hand-written description approves", /Approved/.test(await selected()) || /approved/.test((await detail()).status), await selected());
check("W5  it counts toward the export", await page.evaluate(() =>
  /1 approved/.test(document.getElementById("batchSummary").textContent)),
  await page.textContent("#batchSummary"));

// ---- W6: "Describe all" leaves it alone
await page.evaluate(() => { document.getElementById("apiKey").value = "sk-test"; document.getElementById("apiKey").dispatchEvent(new Event("input", { bubbles: true })); });
await page.waitForTimeout(150);
await page.click("#describeBtn");
await page.waitForFunction(() => document.getElementById("progressCard").hidden, null, { timeout: 15000 });
await page.waitForTimeout(300);
check("W6  the batch described only the other slide", apiCalls === 1, `apiCalls=${apiCalls}`);
check("W6  the hand-written one is untouched", await page.evaluate(() => {
  const rows = [...document.querySelectorAll("#railList .rail-row")];
  rows[0].click();
  return true;
}) && /enrolment by term/.test(await page.textContent("#detailPane .js-preview")));

// ---- W7: an empty draft is discarded rather than left approvable
// Both existing slides now have descriptions, so this needs a fresh one.
await addFiles(page, [{ name: "M1_L1_S3.png", mimeType: "image/png", buffer: png }]);
await page.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length === 3);
await page.evaluate(() => [...document.querySelectorAll("#railList .rail-row")][2].click());
await page.waitForTimeout(200);
await page.click("#detailPane .js-pending-write");
await page.waitForTimeout(200);
await page.click("#detailPane .js-edit"); // save with nothing typed
await page.waitForTimeout(250);
d = await detail();
check("W7  an empty draft goes back to not described", d.pendingVisible && !d.descVisible && d.writeVisible, JSON.stringify(d));
check("W7  and says so", /Nothing written/.test(d.status), d.status);
check("W7  no undo is offered for a draft that never existed", await page.evaluate(() =>
  document.querySelector("#detailPane .js-undo") === null || document.querySelector("#detailPane .js-undo").hidden));

// ---- W8: it survives a save/reload round trip
await page.evaluate(() => [...document.querySelectorAll("#railList .rail-row")][0].click());
await page.waitForTimeout(3000); // let the debounced autosave flush
await page.reload({ waitUntil: "load" });
if (!(await page.$eval("#onboarding", (o) => o.hidden))) await page.click("#onboardSkip");
await page.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length >= 2, null, { timeout: 15000 });
await page.waitForTimeout(400);
const restored = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("#railList .rail-row")];
  const hand = rows.find((r) => /Written by you|Approved/.test(r.textContent));
  hand?.click();
  return {
    rows: rows.length,
    html: document.querySelector("#detailPane .js-preview")?.textContent || "",
    meta: document.querySelector("#detailPane .js-desc-meta")?.textContent || "",
  };
});
check("W8  the hand-written description survives a reload", /enrolment by term/.test(restored.html), JSON.stringify(restored));
check("W8  still credited to the person after a reload", /written by you/.test(restored.meta), restored.meta);
check("W8  still nothing sent", apiCalls === 1, `apiCalls=${apiCalls}`);

check("Z  no console errors or CSP violations", problems.length === 0, problems.join(" | "));

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
