// Transcript pairing against realistic files and names. Each case drops one
// image and one caption file together and reads the rail's verdict.
import { launch, makeImage, openWorkspace, srt } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const at223 = srt([{ start: 130, end: 150, text: "splitting cells" }]);
const ok = srt([{ start: 0, end: 4, text: "a" }, { start: 4, end: 9, text: "b" }, { start: 250, end: 300, text: "around 4:32" }]);
// expect: "yes" = attached; "time" = name matched but no captions near; "no" = no name match
const cases = [
  ["baseline", "Lecture_3.srt", ok, "Lecture_3_00-04-32.png", "yes"],
  ["case differs", "lecture_3.srt", ok, "Lecture_3_00-04-32.png", "yes"],
  ["browser (1) suffix", "Lecture_3.srt", ok, "Lecture_3_00-04-32 (1).png", "yes"],
  ["macOS copy suffix", "Lecture_3.srt", ok, "Lecture_3_00-04-32 copy.png", "yes"],
  ["time outside transcript", "Lecture_3.srt", ok, "Lecture_3_00-45-00.png", "time"],
  ["language tag .en.srt", "Lecture_3.en.srt", ok, "Lecture_3_00-04-32.png", "yes"],
  ["spaces in both", "My Lecture 3.srt", ok, "My Lecture 3_00-04-32.png", "yes"],
  ["srt without milliseconds", "Lecture_3.srt", "1\n00:00:00 --> 00:00:04\na\n\n2\n00:04:10 --> 00:05:00\nb\n", "Lecture_3_00-04-32.png", "yes"],
  ["whitespace-only separators", "Lecture_3.srt", "1\n00:00:00,000 --> 00:00:04,000\na\n \n2\n00:04:10,000 --> 00:05:00,000\nb\n", "Lecture_3_00-04-32.png", "yes"],
  ["BOM + CRLF", "Lecture_3.srt", "﻿" + ok.replace(/\n/g, "\r\n"), "Lecture_3_00-04-32.png", "yes"],
  ["vtt without hours", "Lecture_3.vtt", "WEBVTT\n\n00:00.000 --> 00:04.000\na\n\n04:10.000 --> 05:00.000\nb\n", "Lecture_3_00-04-32.png", "yes"],
  ["stem with a dot", "Lecture 3.2.srt", ok, "Lecture 3.2_00-04-32.png", "yes"],
  ["wrong stem", "Physics.srt", ok, "Lecture_3_00-04-32.png", "no"],
  ["no timestamp in image name", "Lecture_3.srt", ok, "Slide1.png", "no"],
  ["hyphen before the timestamp", "Lecture_3.srt", ok, "Lecture_3-00-04-32.png", "yes"],
  ["srt named after the frame", "Lecture_3-00-04-32.srt", ok, "Lecture_3-00-04-32.png", "yes"],
  ["placeholder copied into srt", "Lecture_3_HH-MM-SS.srt", ok, "Lecture_3_00-04-32.png", "yes"],
  ["the reported shape", "UB-CellBio_Cycle_07_Splitting-Cells-00-02-23.srt", at223, "UB-CellBio_Cycle_07_Splitting-Cells-00-02-23.png", "yes"],
  ["hyphenated language tag", "700x-2026_Virology1_01_Two-Pandemics_v1-en.srt", ok, "700x-2026_Virology1_01_Two-Pandemics_v1_00-04-32.png", "yes"],
  ["GNOME screenshot is not a frame", "Screenshot from 2026-08-20.srt", ok, "Screenshot from 2026-08-20 14-30-05.png", "no"],
];

for (const [label, srtName, srtBody, imgName, expect] of cases) {
  const { b, page, problems } = await launch();
  await openWorkspace(page);
  await page.setInputFiles("#fileInput", [
    { name: imgName, mimeType: "image/png", buffer: await makeImage(page, { label }) },
    { name: srtName, mimeType: "text/plain", buffer: Buffer.from(srtBody) },
  ]);
  await page.waitForTimeout(700);
  const r = await page.evaluate(() => {
    const li = document.querySelector("#transcriptList li");
    const row = document.querySelector("#railList .rail-row");
    return {
      present: !!li,
      panelHidden: document.getElementById("railTranscripts").hidden,
      matched: li ? li.dataset.matched : null,
      status: li ? li.querySelector(".rail-status").textContent.replace(/\s+/g, " ") : document.getElementById("statusMessage").textContent.trim(),
      row: row ? row.querySelector(".rail-status").textContent : "",
      rowTranscript: row ? row.dataset.transcript : "",
    };
  });
  let pass;
  // matched: nothing in the panel; the slide row carries the file name and is flagged
  if (expect === "yes") pass = r.panelHidden && r.rowTranscript === "yes" && /· .+\.(srt|vtt)$/i.test(r.row);
  else if (expect === "time") pass = r.present && r.matched === "no" && /Name matches, but no captions near 45:00/.test(r.status) && /captions run through 5:00/.test(r.status);
  else pass = r.present && r.matched === "no" && /^No match/.test(r.status) && /expects slides named like/.test(r.status);
  check(`${label.padEnd(28)} → ${expect}`, pass && problems.length === 0, r.status + (problems.length ? " | " + problems.join(" | ") : ""));
  await b.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
