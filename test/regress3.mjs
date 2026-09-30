// Transcripts in the rail: visible when dropped, say what they matched,
// detachable — in either drop order.
import { launch, makeImage, openWorkspace, srt } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const cues = srt([{ start: 0, end: 4, text: "Today we look at the cell cycle." }, { start: 4, end: 9, text: "G1 is growth, S is synthesis." }]);
const srtFile = (name) => ({ name, mimeType: "text/plain", buffer: Buffer.from(cues) });
async function png(page, name) { return { name, mimeType: "image/png", buffer: await makeImage(page, { w: 400, h: 225, label: name }) }; }
async function addViaRail(page, files) {
  const before = await page.$$eval("#railList li", (l) => l.length);
  const imgs = files.filter((f) => f.mimeType.startsWith("image/")).length;
  await page.setInputFiles(before === 0 && imgs ? "#fileInput" : "#railFileInput", files);
  if (imgs) await page.waitForFunction((n) => document.querySelectorAll("#railList li").length === n, before + imgs);
  else await page.waitForTimeout(300);
}
const railState = (page) => page.evaluate(() => ({
  sectionHidden: document.getElementById("railTranscripts").hidden,
  open: document.getElementById("railTranscripts").open,
  count: (document.getElementById("railTranscriptsCount") || {}).textContent || "",
  rowFlags: [...document.querySelectorAll("#railList .rail-row")].map((r) => r.dataset.transcript),
  items: [...document.querySelectorAll("#transcriptList li")].map((li) => ({ name: li.querySelector(".rail-name").textContent, status: li.querySelector(".rail-status").textContent, matched: li.dataset.matched })),
  rows: [...document.querySelectorAll("#railList .rail-row")].map((r) => ({ name: r.querySelector(".rail-name").textContent, status: r.querySelector(".rail-status").textContent })),
  pageStatus: document.getElementById("statusMessage").textContent.trim(),
  active: document.activeElement === document.body ? "BODY" : (document.activeElement.id || document.activeElement.className),
}));

// ---------- transcript first, slides after
{
  const { b, page, problems } = await launch();
  await openWorkspace(page);
  await addViaRail(page, [srtFile("Lecture_3.srt")]);
  let s = await railState(page);
  check("T1  a lone transcript appears in the rail, unmatched, naming the pattern", !s.sectionHidden && s.items.length === 1 && s.items[0].matched === "no" && /^No match\s*expects slides named like Lecture_3_00-00-04\.png$/.test(s.items[0].status), JSON.stringify(s.items));

  await addViaRail(page, [await png(page, "Lecture_3_00-00-05.png"), await png(page, "Other.png")]);
  s = await railState(page);
  check("T2  once matched, the transcript leaves the panel", s.sectionHidden && s.items.length === 0, JSON.stringify(s.items));
  check("T2  the matched row names the file and is flagged green, the other is not", /· Lecture_3\.srt$/.test(s.rows[0].status) && s.rowFlags[0] === "yes" && !/srt/.test(s.rows[1].status) && s.rowFlags[1] === "no", s.rows.map((r) => r.status).join(" | "));

  // Detach now lives in the matched slide's detail pane.
  await page.evaluate(() => document.querySelectorAll("#railList .rail-row")[0].click());
  await page.click(".js-detach-transcript");
  s = await railState(page);
  check("T3  detach clears the slide's context and its flag, quietly", s.sectionHidden && !/srt/.test(s.rows[0].status) && s.rowFlags[0] === "no" && !/Detached/.test(s.pageStatus), `${s.rows[0].status} | ${s.pageStatus}`);
  check("T3  focus did not fall to <body>", s.active !== "BODY", s.active);
  check("T   no page errors", problems.length === 0, problems.join(" | "));
  await b.close();
}

// ---------- slides first, transcript after; plus a non-matching name
{
  const { b, page, problems } = await launch();
  await openWorkspace(page);
  await addViaRail(page, [await png(page, "Lecture_3_00-00-05.png"), await png(page, "Other.png")]);
  await addViaRail(page, [srtFile("Lecture_3.srt")]);
  let s = await railState(page);
  check("T4  transcript dropped after the slides attaches to the named one, with no status chatter", s.sectionHidden && s.rowFlags[0] === "yes" && s.rowFlags[1] === "no" && !/[Tt]ranscript "/.test(s.pageStatus), `${s.rowFlags} | ${s.pageStatus}`);

  await addViaRail(page, [srtFile("Physics.srt")]);
  s = await railState(page);
  const phys = s.items.find((i) => i.name === "Physics.srt");
  check("T5  a transcript that matches nothing says so and names the pattern it wants", !!phys && phys.matched === "no" && /^No match\s*expects slides named like Physics_00-00-04\.png$/.test(phys.status), phys && phys.status);
  check("T5  only the unmatched transcript is listed", !s.sectionHidden && s.items.length === 1 && s.items[0].name === "Physics.srt", JSON.stringify(s.items));
  check("T6  the drawer opened for it and counts it", s.open === true && s.count === "1", `open=${s.open} count=${s.count}`);
  await page.click("#railTranscripts summary"); // collapse it
  s = await railState(page);
  check("T6  it stays collapsed after a click", s.open === false, `open=${s.open}`);
  await addViaRail(page, [srtFile("Chemistry.srt")]);
  s = await railState(page);
  check("T6  a new unmatched file reopens it", s.open === true && s.count === "2", `open=${s.open} count=${s.count}`);
  check("T   no page errors", problems.length === 0, problems.join(" | "));
  await b.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
