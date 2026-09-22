// Jump-to-time in the video dialog.
import { launch, makeVideo, openWorkspace } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const { b, page, problems } = await launch();
await openWorkspace(page);
const vid = await makeVideo(page, { seconds: 8 });
await page.click("#videoBtn");
await page.setInputFiles("#videoInput", [{ name: "Lecture_3.webm", mimeType: "video/webm", buffer: vid }]);
await page.waitForFunction(() => !document.getElementById("videoStage").hidden);
// The MediaRecorder fixture reports no duration, so seeks are not clamped —
// that is the un-clamped path, exercised deliberately here.
const state = () => page.evaluate(() => ({
  value: document.getElementById("videoTimeInput").value,
  time: +document.getElementById("videoEl").currentTime.toFixed(2),
  err: document.getElementById("videoError").hidden ? "" : document.getElementById("videoError").textContent,
  status: document.getElementById("videoStatus").textContent,
}));

async function typeTime(text) {
  await page.click("#videoTimeInput");
  await page.fill("#videoTimeInput", text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  return state();
}

// ---- the readout is a real input, labelled for what it does
const meta = await page.evaluate(() => {
  const el = document.getElementById("videoTimeInput");
  return { tag: el.tagName, label: el.getAttribute("aria-label"), described: !!document.getElementById(el.getAttribute("aria-describedby")) };
});
check("V1  the time readout is an input", meta.tag === "INPUT", meta.tag);
check("V1  its name says typing a time jumps there", /type a time/i.test(meta.label) && /Enter/.test(meta.label), meta.label);
check("V1  its accepted formats are described", meta.described);

// ---- the three formats
let r = await typeTime("0:03");
check("V2  m:ss jumps", Math.abs(r.time - 3) < 0.5 && r.value === "0:03", JSON.stringify(r));
r = await typeTime("5");
check("V2  plain seconds jump", Math.abs(r.time - 5) < 0.5 && r.value === "0:05", JSON.stringify(r));
r = await typeTime("0:00:06");
check("V2  h:mm:ss jumps", Math.abs(r.time - 6) < 0.5 && r.value === "0:06", JSON.stringify(r));
check("V2  the jump is announced", /Moved to 0:06/.test(r.status), r.status);

// ---- rejections keep the clock where it was and say so
const before = (await state()).time;
r = await typeTime("4:75");
check("V3  out-of-range seconds are a typo, not 5:15", Math.abs(r.time - before) < 0.2 && /could not be read/.test(r.err), JSON.stringify(r));
r = await typeTime("banana");
check("V3  nonsense is refused and the readout restored", /could not be read/.test(r.err) && r.value === r.time.toFixed(0).replace(/^(\d+)$/, (m) => `0:${String(m).padStart(2, "0")}`), JSON.stringify(r));

// ---- Escape abandons the edit
await page.click("#videoTimeInput");
await page.fill("#videoTimeInput", "0:07");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
r = await state();
check("V4  Escape abandons the edit without seeking", Math.abs(r.time - before) < 0.5, JSON.stringify(r));

// ---- focusing during playback and leaving must not rewind
await page.evaluate(() => { const v = document.getElementById("videoEl"); v.currentTime = 0; return v.play(); });
await page.waitForTimeout(300);
await page.click("#videoTimeInput");     // readout freezes while focused
await page.waitForTimeout(700);          // playback runs on underneath
const frozen = (await state()).value;
await page.evaluate(() => document.getElementById("videoTimeInput").blur());
await page.waitForTimeout(250);
const after = await state();
await page.evaluate(() => document.getElementById("videoEl").pause());
check("V5  focusing during playback freezes the readout", frozen === "0:00" || /^0:0\d$/.test(frozen), frozen);
check("V5  blurring without typing does not rewind to the frozen readout", after.time > 0.6, `frozen=${frozen} now=${after.time}`);

// ---- typing then tabbing away still honours it
await page.click("#videoTimeInput");
await page.fill("#videoTimeInput", "0:02");
await page.evaluate(() => document.getElementById("videoTimeInput").blur());
await page.waitForTimeout(250);
r = await state();
check("V6  typing then blurring seeks", Math.abs(r.time - 2) < 0.5, JSON.stringify(r));

// ---- Space in the field types, and does not toggle playback
await page.evaluate(() => document.getElementById("videoEl").pause());
await page.click("#videoTimeInput");
await page.fill("#videoTimeInput", "");
await page.keyboard.press("Space");
await page.waitForTimeout(200);
const spaced = await page.evaluate(() => ({ paused: document.getElementById("videoEl").paused, value: document.getElementById("videoTimeInput").value }));
check("V7  Space in the time field does not start playback", spaced.paused === true, JSON.stringify(spaced));

check("V   no page errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));
await b.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
