// Shared project folders — a lecture saved to a folder the team syncs
// (Dropbox, for the team this was built for), behind ?learner-downloads.
//
// Chrome's folder picker is native UI no test can click through, so the
// picker is handed the browser's own private folder (OPFS), which has the
// same interface as a folder on disk. A teammate is simulated the way the
// sync service would show up: files appearing and changing in that folder.
import { launch, makeImage, openWorkspace, APP_URL } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

// Polls an async check in the page until it holds. Not waitForFunction: it
// takes the promise an async predicate returns as already true.
async function until(page, fn, arg, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
const FLAGGED = `${APP_URL}?learner-downloads`;
const project = (name, jobs) => ({ format: "describeme-project", version: 1, name, savedAt: new Date().toISOString(), jobs });

const { b, page, problems } = await launch();

// The confirm()s the app asks, and an answer for the next one when a check
// needs "no" (the fixtures say yes to everything).
await page.addInitScript(() => {
  window.__confirms = [];
  window.__confirmAnswer = null;
  const real = window.confirm.bind(window);
  window.confirm = (message) => {
    window.__confirms.push(message);
    if (window.__confirmAnswer !== null) { const a = window.__confirmAnswer; window.__confirmAnswer = null; return a; }
    return real(message);
  };
});

// ---------- F0: without the flag there is no folder section
await openWorkspace(page);
check("F0  without ?learner-downloads the folder section stays hidden",
  await page.evaluate(() => { document.getElementById("projectsBtn").click(); return document.getElementById("folderSection").hidden; }));
await page.click("#projectsClose");

await openWorkspace(page, FLAGGED);
// The "shared folder": a fresh OPFS directory, handed to the picker.
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry("team", { recursive: true }).catch(() => {});
  window.showDirectoryPicker = async () => root.getDirectoryHandle("team", { create: true });
});
// Helpers the checks read the folder with.
await page.evaluate(() => {
  window.__team = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("team");
  window.__read = async (dir, name) => JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
  window.__lecture = async (name) => (await window.__team()).getDirectoryHandle(name);
  window.__images = async (name) => { const d = await (await window.__lecture(name)).getDirectoryHandle("images"); const out = []; for await (const [n] of d.entries()) out.push(n); return out.sort(); };
  window.__write = async (dir, name, text) => { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(text); await w.close(); };
});

// A three-slide batch: one PNG small enough to need no API copy, one large
// enough to carry an original beside it, one with no description yet.
const small = await makeImage(page, { w: 400, h: 225, label: "small" });
const large = await makeImage(page, { w: 2400, h: 1350, label: "large" });
await page.click("#projectsBtn");
await page.setInputFiles("#importProjectInput", [{
  name: "p.describeme.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(project("Cell Biology: L3", [
    { name: "one.png", state: "done", approved: true, history: [], resultHtml: "<h2>One</h2><p>First.</p>", resultText: "One First.", dataUrl: `data:image/png;base64,${small.toString("base64")}`, mediaType: "image/png", width: 400, height: 225 },
    { name: "two.png", state: "done", approved: false, history: [], resultHtml: "<h2>Two</h2><p>Second.</p>", resultText: "Two Second.", dataUrl: `data:image/png;base64,${small.toString("base64")}`, mediaType: "image/png", width: 400, height: 225, captureSeconds: 272 },
    { name: "big.png", state: "pending", approved: false, history: [], resultHtml: "", resultText: "", dataUrl: `data:image/png;base64,${small.toString("base64")}`, mediaType: "image/png", width: 400, height: 225, originalBase64: large.toString("base64"), originalMediaType: "image/png" },
  ]))),
}]);
await page.waitForSelector('#projectList button[aria-label="Open project Cell Biology: L3"]');

// ---------- F1: choosing the folder
check("F1  with the flag, the folder section shows", !(await page.$eval("#folderSection", (e) => e.hidden)));
await page.click("#chooseFolderBtn");
await page.waitForFunction(() => !document.getElementById("folderReady").hidden, null, { timeout: 5000 });
check("F1  choosing a folder makes it the shared folder", (await page.textContent("#folderStateText")).includes('Using "team"'));
check("F1  browser projects can be copied to it", await page.$('#projectList button[aria-label="Copy project Cell Biology: L3 to the shared folder"]') !== null);
await page.fill("#folderUserName", "Ana");
await page.dispatchEvent("#folderUserName", "change");

// ---------- F2: copying a browser project into the folder, then opening it
await page.click('#projectList button[aria-label="Copy project Cell Biology: L3 to the shared folder"]');
await page.waitForSelector('#folderList button[aria-label="Open lecture Cell Biology: L3 from the shared folder"]', { timeout: 5000 });
const dirName = "Cell Biology- L3"; // ":" is not allowed in a file name
const copied = await page.evaluate(async (n) => {
  const json = await window.__read(await window.__lecture(n), "project.json");
  return { json, raw: JSON.stringify(json), images: await window.__images(n) };
}, dirName);
check("F2  a copied project becomes a lecture folder, named safely", copied.json.format === "describeme-lecture" && copied.json.name === "Cell Biology: L3");
check("F2  project.json carries no image data", !/base64|data:image/.test(copied.raw), `${copied.raw.length} bytes`);
check("F2  each distinct image is stored once, named by its content", copied.images.length === 2 && copied.images.every((n) => /^[0-9a-f]{64}\.png$/.test(n)), copied.images.join(", "));

await page.click('#folderList button[aria-label="Open lecture Cell Biology: L3 from the shared folder"]');
await page.waitForFunction(() => document.querySelectorAll("#railList li").length === 3, null, { timeout: 5000 });
const opened = await page.evaluate(() => {
  const list = [...jobs.values()];
  return {
    names: list.map((j) => j.name),
    html: list.map((j) => j.resultHtml),
    approved: list.map((j) => j.approved),
    capture: list[1].captureSeconds,
    originalKept: !!list[2].originalBase64 && list[2].originalBase64.length > list[2].base64.length,
    link: folderLecture && folderLecture.dir,
    saveLabel: document.getElementById("railSaveBtn").textContent.trim(),
  };
});
check("F2  opening it brings back every slide and description", opened.names.join() === "one.png,two.png,big.png" && opened.html[0] === "<h2>One</h2><p>First.</p>", JSON.stringify(opened.names));
check("F2  approvals, timestamps and full-size originals come back too", opened.approved.join() === "true,false,false" && opened.capture === 272 && opened.originalKept);
check("F2  the batch is now that lecture, and says it is saved", opened.link === dirName && opened.saveLabel === "Saved", `${opened.link} / ${opened.saveLabel}`);
const note = await page.evaluate(async (n) => window.__read(await window.__lecture(n), "in-use.json"), dirName);
check("F2  an in-use note says who has it open", note.by === "Ana" && typeof note.session === "string");

// ---------- F3: it saves to the folder as you work
const before = await page.evaluate(async (n) => (await window.__read(await window.__lecture(n), "project.json")).saveId, dirName);
await page.evaluate(() => { const j = [...jobs.values()][1]; j.approved = true; renderAll(); });
const saved = await until(page, async (n) => (await window.__read(await window.__lecture(n), "project.json")).jobs[1].approved === true, dirName, 8000);
const after = await page.evaluate(async (n) => window.__read(await window.__lecture(n), "project.json"), dirName);
check("F3  an approval reaches the folder without pressing Save", saved && after.saveId !== before && after.savedBy === "Ana");

// Removing a slide removes the image only it used.
await page.evaluate(() => { removeJob([...jobs.values()][2].id); });
const trimmed = await until(page, async (n) => (await window.__images(n)).length === 1, dirName, 8000);
check("F3  an image nothing refers to any more is removed", trimmed, JSON.stringify(await page.evaluate((n) => window.__images(n), dirName)));

// ---------- F4: a teammate saves in between — nothing of theirs is overwritten
await page.evaluate(async (n) => {
  const dir = await window.__lecture(n);
  const json = await window.__read(dir, "project.json");
  json.saveId = "ben-save";
  json.savedBy = "Ben";
  json.jobs[0].resultHtml = "<h2>One</h2><p>Ben's rewrite.</p>";
  await window.__write(dir, "project.json", JSON.stringify(json));
}, dirName);
await page.evaluate(() => { const j = [...jobs.values()][0]; j.approved = false; renderAll(); });
await page.waitForTimeout(3500);
const afterConflict = await page.evaluate(async (n) => ({
  disk: await window.__read(await window.__lecture(n), "project.json"),
  error: document.getElementById("errorMessage").hidden ? "" : document.getElementById("errorMessage").textContent,
  conflict: !!(folderLecture && folderLecture.conflict),
  label: document.getElementById("railSaveBtn").textContent.trim(),
}), dirName);
check("F4  Ben's save is left as he made it", afterConflict.disk.saveId === "ben-save" && afterConflict.disk.jobs[0].resultHtml.includes("Ben's rewrite"));
check("F4  and the page says why it stopped saving", afterConflict.conflict && /Ben saved/.test(afterConflict.error) && /not being saved there/.test(afterConflict.error), afterConflict.error.slice(0, 90));
check("F4  Save no longer claims Saved", afterConflict.label === "Save");

// Save, then "no": still theirs. Save, then "yes": ours.
await page.evaluate(() => { window.__confirmAnswer = false; });
await page.click("#railSaveBtn");
await page.waitForTimeout(800);
const kept = await page.evaluate(async (n) => (await window.__read(await window.__lecture(n), "project.json")).saveId, dirName);
const asked = await page.evaluate(() => window.__confirms[window.__confirms.length - 1] || "");
check("F4  Save asks before replacing their version, naming them", /^Ben saved .* Replace their version with yours\?$/.test(asked), asked.slice(0, 80));
check("F4  and answering no leaves it theirs", kept === "ben-save");
await page.click("#railSaveBtn");
const replaced = await until(page, async (n) => { const j = await window.__read(await window.__lecture(n), "project.json"); return j.savedBy === "Ana" && j.saveId !== "ben-save"; }, dirName, 5000);
check("F4  answering yes saves yours", replaced);

// ---------- F5: someone else's in-use note is mentioned before opening
await page.evaluate(async (n) => {
  await window.__write(await window.__lecture(n), "in-use.json", JSON.stringify({ by: "Ben", session: "elsewhere", since: new Date().toISOString(), active: new Date().toISOString() }));
}, dirName);
await page.click("#projectsBtn");
await page.waitForSelector("#folderList li");
const listed = await page.textContent("#folderList");
check("F5  the folder list shows who has a lecture open", /open now/.test(listed), listed.replace(/\s+/g, " ").slice(0, 120));
await page.evaluate(() => { window.__confirmAnswer = false; });
await page.click(`#folderList button[aria-label="Open lecture Cell Biology: L3 from the shared folder"]`);
await page.waitForTimeout(500);
const warned = await page.evaluate(() => window.__confirms[window.__confirms.length - 1] || "");
check("F5  opening it asks first, naming who has it", /^Ben has this lecture open/.test(warned), warned.slice(0, 60));

// ---------- F6: a new lecture from the current batch, and a name clash
await page.evaluate(() => { leaveFolderLecture(); els.batchName.value = "Lecture 4"; renderAll(); });
await page.evaluate(() => renderFolderSection());
await page.click("#saveToFolderBtn");
const created = await until(page, async () => { try { await (await window.__lecture("Lecture 4")).getFileHandle("project.json"); return true; } catch { return false; } }, null, 5000);
check("F6  Save current batch to folder makes a new lecture", created);
await page.evaluate(() => { leaveFolderLecture(); renderAll(); renderFolderSection(); });
await page.click("#saveToFolderBtn");
await page.waitForTimeout(300);
check("F6  a second batch of the same name is refused, not saved over it",
  /already in the folder/.test(await page.textContent("#folderError")));
await page.click("#projectsClose");

// ---------- F7: a damaged or hostile lecture cannot reach outside images/
await page.evaluate(async () => {
  const dir = await (await window.__team()).getDirectoryHandle("Odd", { create: true });
  await window.__write(dir, "project.json", JSON.stringify({ format: "describeme-lecture", version: 1, name: "Odd", saveId: "x", jobs: [
    { name: "../../escape.png", state: "done", approved: true, resultHtml: "<h2>T</h2><img src=x onerror=alert(1)><p>ok</p>", imageFile: "../../../secret.png", mediaType: "image/png" },
  ] }));
});
await page.click("#projectsBtn");
await page.waitForSelector('#folderList button[aria-label="Open lecture Odd from the shared folder"]');
await page.click('#folderList button[aria-label="Open lecture Odd from the shared folder"]');
await page.waitForFunction(() => document.getElementById("batchName").value === "Odd", null, { timeout: 5000 });
const odd = await page.evaluate(() => { const j = [...jobs.values()][0]; return { state: j.state, name: j.name, html: j.resultHtml }; });
check("F7  an image path outside images/ is not followed — the slide is invalid", odd.state === "invalid");
check("F7  and the lecture is sanitized like any imported project", odd.name === "escape.png" && !/onerror|<img/.test(odd.html), JSON.stringify(odd));

// ---------- F8: a reload rejoins the lecture
await page.evaluate(() => { leaveFolderLecture(); });
await page.click("#projectsBtn");
await page.waitForSelector('#folderList button[aria-label="Open lecture Lecture 4 from the shared folder"]');
await page.click('#folderList button[aria-label="Open lecture Lecture 4 from the shared folder"]');
await page.waitForFunction(() => folderLecture && folderLecture.dir === "Lecture 4", null, { timeout: 5000 });
await page.evaluate(() => writeAutosave());
await page.reload({ waitUntil: "load" });
const rejoined = await page
  .waitForFunction(() => typeof folderLecture !== "undefined" && folderLecture && folderLecture.dir === "Lecture 4", null, { timeout: 8000 })
  .then(() => true, () => false);
check("F8  after a reload, the restored batch is that lecture again", rejoined);

// The page's helpers went with the reload.
await page.evaluate(() => {
  window.__team = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("team");
  window.__lecture = async (name) => (await window.__team()).getDirectoryHandle(name);
  window.__read = async (dir, name) => JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
  window.__write = async (dir, name, data) => { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(data); await w.close(); };
  window.showDirectoryPicker = async () => window.__team();
});

// ---------- F9: this browser's own latest save is never taken for a teammate's
// A reload or a reopened tab can restore a copy that is one save behind its
// own work (the autosave copy lags a folder save, and the last save before a
// tab closes comes after it). That save is on the same line, and is ours.
const f9Base = await page.evaluate(() => folderLecture.saveId);
await page.evaluate(() => { const j = [...jobs.values()][0]; j.approved = !j.approved; renderAll(); });
await until(page, (base) => folderLecture.saveId !== base, f9Base, 8000);
// Now pretend this tab only knew the save before that one.
await page.evaluate((base) => { folderLecture.saveId = base; const j = [...jobs.values()][0]; j.approved = !j.approved; renderAll(); }, f9Base);
const ownOk = await until(page, async (base) => {
  const j = await window.__read(await window.__lecture("Lecture 4"), "project.json");
  return folderLecture.saveId !== base && folderLecture.saveId === j.saveId;
}, f9Base, 8000);
check("F9  a save this browser made itself is not reported as a teammate's",
  ownOk && !(await page.evaluate(() => folderLecture.conflict)),
  await page.evaluate(() => (document.getElementById("errorMessage").hidden ? "" : document.getElementById("errorMessage").textContent)));

// ---------- F10: "Save current batch", under "In this browser", saves to the browser
await page.evaluate(() => { els.batchName.value = "Lecture 4 copy"; renderAll(); });
await page.click("#projectsBtn");
await page.click("#saveProjectBtn");
const inBrowser = await page
  .waitForSelector('#projectList button[aria-label="Open project Lecture 4 copy"]', { timeout: 5000 })
  .then(() => true, () => false);
check("F10  the browser section's Save saves to the browser, even with a folder lecture open", inBrowser);
// …and the folder still gets that change: a browser save does not tell the
// folder's autosave it is up to date.
const folderGotIt = await until(page, async () => (await window.__read(await window.__lecture("Lecture 4"), "project.json")).name === "Lecture 4 copy", null, 8000);
check("F10  and the folder still gets the change", folderGotIt);
await page.click("#projectsClose");

// ---------- R: the review's findings, each held down
// R1: a save that is still reading the folder when the batch is cleared
// must not write the cleared batch over the lecture.
const r1Before = await page.evaluate(async () => {
  const j = await window.__read(await window.__lecture("Lecture 4"), "project.json");
  return { saveId: j.saveId, count: j.jobs.length };
});
await page.evaluate(() => {
  // Slow the save's read of project.json, as a Dropbox online-only file would be.
  const handle = folderLecture.handle;
  const real = handle.getFileHandle.bind(handle);
  handle.getFileHandle = async (name, opts) => {
    if (name === "project.json" && !opts) await new Promise((r) => setTimeout(r, 1200));
    return real(name, opts);
  };
  const j = [...jobs.values()][0];
  j.approved = !j.approved;
  window.__r1 = saveFolderLecture();
  // While that save is reading the folder: the batch on screen stops being
  // this lecture and becomes something else.
  setTimeout(() => {
    leaveFolderLecture();
    els.batchName.value = "Some other batch";
    renderAll();
  }, 300);
});
await page.evaluate(() => window.__r1);
const r1After = await page.evaluate(async () => {
  const j = await window.__read(await window.__lecture("Lecture 4"), "project.json");
  return { saveId: j.saveId, count: j.jobs.length, name: j.name };
});
check("R1  a batch switched mid-save is not written into the lecture it left",
  r1After.saveId === r1Before.saveId && r1After.name !== "Some other batch", JSON.stringify({ r1Before, r1After }));
await page.evaluate(() => { jobs.clear(); els.railList.replaceChildren(); renderAll(); });

// R2: a reconnect still waiting for permission is dropped when the batch is replaced.
await page.evaluate(() => { pendingFolderRelink = { dir: "Lecture 4", saveId: "x" }; });
await page.click("#projectsBtn");
await page.click('#projectList button[aria-label="Open project Lecture 4 copy"]');
// Its slides, not its name: R1 left the name in the header already.
await page.waitForFunction(() => jobs.size > 0, null, { timeout: 5000 });
const r2 =await page.evaluate(async () => { await relinkFolderLecture(); return { pending: pendingFolderRelink, linked: !!folderLecture }; });
check("R2  opening another project drops a pending reconnect, so it cannot attach that project to the old lecture", r2.pending === null && r2.linked === false, JSON.stringify(r2));

// R3: a first save that fails leaves no empty folder to block the next try.
await page.evaluate(() => {
  els.batchName.value = "Lecture 5";
  renderAll();
  window.__realWrite = writeFolderFile;
  writeFolderFile = async (dir, name, data) => { if (name === "project.json") throw new Error("disk full"); return window.__realWrite(dir, name, data); };
});
await page.click("#projectsBtn");
await page.evaluate(() => renderFolderSection());
await page.click("#saveToFolderBtn");
await page.waitForFunction(() => !document.getElementById("folderError").hidden, null, { timeout: 5000 });
const r3Gone = await page.evaluate(async () => { try { await window.__lecture("Lecture 5"); return false; } catch { return true; } });
check("R3  a failed first save leaves no lecture folder behind, and no lecture open", r3Gone && !(await page.evaluate(() => !!folderLecture)));
await page.evaluate(() => { writeFolderFile = window.__realWrite; });
await page.click("#saveToFolderBtn");
const r3Retry = await until(page, async () => { try { await (await window.__lecture("Lecture 5")).getFileHandle("project.json"); return true; } catch { return false; } }, null, 5000);
check("R3  and trying again works, rather than being refused as a name clash", r3Retry, await page.textContent("#folderError"));
await page.click("#projectsClose");

// R4: re-opening the lecture just left keeps its "open by" note.
await page.evaluate(() => leaveFolderLecture());
await page.click("#projectsBtn");
await page.waitForSelector('#folderList button[aria-label="Open lecture Lecture 5 from the shared folder"]');
await page.click('#folderList button[aria-label="Open lecture Lecture 5 from the shared folder"]');
await page.waitForFunction(() => folderLecture && folderLecture.dir === "Lecture 5", null, { timeout: 5000 });
await page.evaluate(() => inUseChain);
const r4 = await page.evaluate(async () => {
  try { const n = await window.__read(await window.__lecture("Lecture 5"), "in-use.json"); return n.open === folderLecture.openId; } catch { return false; }
});
check("R4  after leaving and re-opening a lecture, its in-use note is the new one", r4);

// R5: two tabs in this browser on one lecture are two branches of the chain.
// Both opened at "base"; tab 1 saved "t1", tab 2 saved "t2". Tab 1, finding
// t2 on disk, must see someone else's save; a tab that only knew "base" may
// take t2 as built on what it saw.
{
  const r5 = await page.evaluate(() => {
    rememberOwnSave("r5-t1", "r5-base");
    rememberOwnSave("r5-t2", "r5-base");
    return { tab1: savedOnTopOf("r5-t2", "r5-t1"), fromBase: savedOnTopOf("r5-t2", "r5-base"), stranger: savedOnTopOf("not-ours", "r5-base") };
  });
  check("R5  another tab's save, built on what this tab never saw, is someone else's", r5.tab1 === false && r5.fromBase === true && r5.stranger === false, JSON.stringify(r5));
}

// R6: hiding the tab sends a pending change to the folder straight away.
await page.evaluate(() => { const j = [...jobs.values()][0]; j.approved = !j.approved; renderAll(); });
const r6Start = Date.now();
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
});
const r6 = await until(page, () => !folderBehind(), null, 1500);
check("R6  hiding the tab saves a pending change at once, not after the debounce", r6, `${Date.now() - r6Start} ms`);
await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); });

// R7: a save after a description change hashes no image it has seen before.
await page.evaluate(() => {
  window.__hashes = 0;
  const real = sha256Hex;
  sha256Hex = async (bytes) => { window.__hashes += 1; return real(bytes); };
  const j = [...jobs.values()][0];
  j.resultHtml = "<h2>One</h2><p>Reworded.</p>";
  renderAll();
});
await page.evaluate(() => saveFolderLecture());
check("R7  re-saving after a text change hashes no images again", await page.evaluate(() => window.__hashes === 0), `${await page.evaluate(() => window.__hashes)} hashed`);
check("R7  and the cache holds only this lecture's current images", await page.evaluate(() => imageNameCache.size <= jobs.size * 2 && imageNameCache.size > 0), `${await page.evaluate(() => imageNameCache.size)} cached`);

// ---------- N: the second review's findings
// N1: a same-named folder with anything in it — a teammate's lecture still
// arriving through Dropbox, images first — is not saved into.
await page.evaluate(async () => {
  const dir = await (await window.__team()).getDirectoryHandle("Lecture 9", { create: true });
  const images = await dir.getDirectoryHandle("images", { create: true });
  await window.__write(images, "ben.png", "not really a png");
  leaveFolderLecture();
  els.batchName.value = "Lecture 9";
  renderAll();
});
await page.click("#projectsBtn");
await page.evaluate(() => renderFolderSection());
await page.click("#saveToFolderBtn");
await page.waitForTimeout(400);
const n1 = await page.evaluate(async () => {
  const images = await (await window.__lecture("Lecture 9")).getDirectoryHandle("images");
  let ben = false;
  try { await images.getFileHandle("ben.png"); ben = true; } catch {}
  return { refused: /already in the folder/.test(document.getElementById("folderError").textContent), ben, linked: !!folderLecture };
});
check("N1  a same-named folder still filling in is refused, and its files are left alone", n1.refused && n1.ben && !n1.linked, JSON.stringify(n1));

// N2: a failed save to the folder leaves the batch linked to its browser project.
const n2 = await page.evaluate(async () => {
  els.batchName.value = "Lecture 10";
  currentProjectId = "browser-project-10";
  renderAll();
  const real = writeFolderFile;
  writeFolderFile = async (dir, name, data) => { if (name === "project.json") throw new Error("disk full"); return real(dir, name, data); };
  await saveBatchToFolder();
  writeFolderFile = real;
  return { projectId: currentProjectId, linked: !!folderLecture };
});
check("N2  a failed save to the folder keeps the batch's link to its browser project", n2.projectId === "browser-project-10" && !n2.linked, JSON.stringify(n2));
await page.evaluate(() => { currentProjectId = null; });
await page.click("#projectsClose");

// N3: a reconnect waiting on permission survives the next autosave.
const n3 = await page.evaluate(async () => {
  pendingFolderRelink = { dir: "Lecture 4", saveId: "kept" };
  autosaveDirty = true;
  await writeAutosave();
  const record = await projectStoreRequest("readonly", (store) => store.get(AUTOSAVE_ID));
  pendingFolderRelink = null;
  return record && record.folderLecture;
});
check("N3  the autosave keeps a reconnect still waiting on permission", n3 && n3.dir === "Lecture 4" && n3.saveId === "kept", JSON.stringify(n3));

// N4: folder saves don't make a browser project read "Saved".
await page.click("#projectsBtn");
await page.waitForSelector('#folderList button[aria-label="Open lecture Lecture 5 from the shared folder"]');
await page.click('#folderList button[aria-label="Open lecture Lecture 5 from the shared folder"]');
await page.waitForFunction(() => folderLecture && folderLecture.dir === "Lecture 5", null, { timeout: 5000 });
await page.evaluate(() => { els.batchName.value = "Lecture 5 browser copy"; renderAll(); });
await page.click("#projectsBtn");
await page.click("#saveProjectBtn"); // into the browser
await page.waitForSelector('#projectList button[aria-label="Open project Lecture 5 browser copy"]', { timeout: 5000 });
await page.click("#projectsClose");
await page.evaluate(() => { const j = [...jobs.values()][0]; j.approved = !j.approved; renderAll(); });
await until(page, () => !folderBehind(), null, 8000);
const n4 = await page.evaluate(() => { leaveFolderLecture(); renderAll(); return { saved: isBatchSaved(), label: document.getElementById("railSaveBtn").textContent.trim() }; });
check("N4  edits saved only to the folder don't make the browser project read Saved", n4.saved === false && n4.label === "Save", JSON.stringify(n4));

// N5: a lecture's undo history keeps who wrote each version.
const n5 = await page.evaluate(async () => {
  const dir = await (await window.__team()).getDirectoryHandle("Lecture 11", { create: true });
  const source = await window.__read(await window.__lecture("Lecture 5"), "project.json");
  const job = { ...source.jobs[0], history: [{ html: "<h2>Mine</h2><p>Hand-written.</p>", text: "Mine", authored: true, edited: false, usedModel: null }], authored: false };
  await window.__write(dir, "project.json", JSON.stringify({ ...source, name: "Lecture 11", saveId: "n5", jobs: [job] }));
  // Its image comes along so the slide is not invalid.
  const images = await dir.getDirectoryHandle("images", { create: true });
  const from = await (await window.__lecture("Lecture 5")).getDirectoryHandle("images");
  const name = job.imageFile.split("/")[1];
  const bytes = await (await (await from.getFileHandle(name)).getFile()).arrayBuffer();
  await window.__write(images, name, bytes);
  return true;
});
await page.click("#projectsBtn");
await page.waitForSelector('#folderList button[aria-label="Open lecture Lecture 11 from the shared folder"]');
await page.click('#folderList button[aria-label="Open lecture Lecture 11 from the shared folder"]');
await page.waitForFunction(() => folderLecture && folderLecture.dir === "Lecture 11", null, { timeout: 5000 });
const n5b = await page.evaluate(() => { const j = [...jobs.values()][0]; const h = j.history[0] || {}; undoRevision(j.id); return { kept: h.authored === true, after: j.authored === true }; });
check("N5  undo in an opened lecture still knows a version was written by a person", n5 && n5b.kept && n5b.after, JSON.stringify(n5b));

// N6: a note this browser left behind earlier is not a warning about a teammate.
await page.evaluate(async () => {
  leaveFolderLecture();
  await inUseChain;
  await window.__write(await window.__lecture("Lecture 11"), "in-use.json", JSON.stringify({ by: "Ana", browser: folderBrowserId(), session: "an-earlier-visit", since: new Date().toISOString(), active: new Date().toISOString() }));
  window.__confirms = [];
});
await page.click("#projectsBtn");
await page.waitForSelector('#folderList button[aria-label="Open lecture Lecture 11 from the shared folder"]');
const n6List = await page.textContent("#folderList");
await page.click('#folderList button[aria-label="Open lecture Lecture 11 from the shared folder"]');
await page.waitForFunction(() => folderLecture && folderLecture.dir === "Lecture 11", null, { timeout: 5000 });
const n6 = await page.evaluate(() => window.__confirms.filter((m) => /has this lecture open/.test(m)).length);
check("N6  your own leftover note doesn't warn you about yourself", n6 === 0 && !/open by Ana/.test(n6List), `${n6} warnings`);

// ---------- M: the third review's findings
// M1: a lecture whose images haven't all arrived is not opened unasked, and
// declining leaves it exactly as it is.
await page.evaluate(async () => {
  const src = await window.__read(await window.__lecture("Lecture 11"), "project.json");
  const dir = await (await window.__team()).getDirectoryHandle("Lecture 12", { create: true });
  await window.__write(dir, "project.json", JSON.stringify({ ...src, name: "Lecture 12", saveId: "m1" }));
  // No images/ yet — as if Dropbox had brought project.json down first.
  window.__confirms = [];
  window.__confirmAnswer = false;
});
await page.click("#projectsBtn");
await page.waitForSelector('#folderList button[aria-label="Open lecture Lecture 12 from the shared folder"]');
await page.click('#folderList button[aria-label="Open lecture Lecture 12 from the shared folder"]');
// Not fatal when it never comes: opening anyway is the failure M1 reports.
await page.waitForFunction(() => !document.getElementById("folderError").hidden || (folderLecture && folderLecture.dir === "Lecture 12"), null, { timeout: 5000 }).catch(() => {});
const m1 = await page.evaluate(async () => ({
  asked: window.__confirms.some((m) => /images aren't in the folder yet/.test(m)),
  opened: !!(folderLecture && folderLecture.dir === "Lecture 12"),
  saveId: (await window.__read(await window.__lecture("Lecture 12"), "project.json")).saveId,
}));
check("M1  a lecture still missing images asks first, and declining leaves it untouched", m1.asked && !m1.opened && m1.saveId === "m1", JSON.stringify(m1));
await page.click("#projectsClose");

// M2: a save made by another tab of this browser that is still open is
// someone else's; once that tab has closed, it is this browser's own.
const m2 = await page.evaluate(() => {
  const parents = JSON.parse(localStorage.getItem("describeme.folderSaveParents") || "{}");
  parents["m2-b"] = { parent: "m2-base", tab: "tab-b" };
  localStorage.setItem("describeme.folderSaveParents", JSON.stringify(parents));
  const tabs = JSON.parse(localStorage.getItem("describeme.folderTabs") || "{}");
  tabs["tab-b"] = Date.now();
  localStorage.setItem("describeme.folderTabs", JSON.stringify(tabs));
  const whileOpen = savedOnTopOf("m2-b", "m2-base");
  const noteWhileOpen = othersNote({ by: "Ana", browser: folderBrowserId(), session: "tab-b" });
  tabs["tab-b"] = Date.now() - 10 * 60 * 1000;
  localStorage.setItem("describeme.folderTabs", JSON.stringify(tabs));
  return { whileOpen, afterClose: savedOnTopOf("m2-b", "m2-base"), noteWhileOpen, noteAfterClose: othersNote({ by: "Ana", browser: folderBrowserId(), session: "tab-b" }) };
});
check("M2  another open tab's save and note count as someone else's; a closed tab's don't",
  m2.whileOpen === false && m2.afterClose === true && m2.noteWhileOpen === true && m2.noteAfterClose === false, JSON.stringify(m2));

// M3: rejoining after a reload leaves a lecture alone when a teammate has it open.
const m3 = await page.evaluate(async () => {
  leaveFolderLecture();
  await inUseChain;
  const dir = await window.__lecture("Lecture 11");
  const disk = await window.__read(dir, "project.json");
  await window.__write(dir, "in-use.json", JSON.stringify({ by: "Ben", browser: "bens-laptop", session: "ben", since: new Date().toISOString(), active: new Date().toISOString() }));
  pendingFolderRelink = { dir: "Lecture 11", saveId: disk.saveId, saved: true };
  await relinkFolderLecture();
  const note = await window.__read(dir, "in-use.json");
  return { linked: !!folderLecture, noteBy: note.by, told: /Ben has "Lecture 11" open/.test(document.getElementById("errorMessage").textContent) };
});
check("M3  rejoining after a reload doesn't take over a lecture a teammate has open", !m3.linked && m3.noteBy === "Ben" && m3.told, JSON.stringify(m3));

// M3b: rejoining a lecture the folder already has in full saves nothing.
const m3b = await page.evaluate(async () => {
  const dir = await window.__lecture("Lecture 11");
  await dir.removeEntry("in-use.json");
  const before = (await window.__read(dir, "project.json")).saveId;
  pendingFolderRelink = { dir: "Lecture 11", saveId: before, saved: true };
  await relinkFolderLecture();
  await new Promise((r) => setTimeout(r, 2600));
  return { linked: !!folderLecture, unchanged: (await window.__read(dir, "project.json")).saveId === before };
});
check("M3  and rejoining one the folder already has in full writes nothing", m3b.linked && m3b.unchanged, JSON.stringify(m3b));

// M4: changing folder sends the open lecture its last edit first.
const m4 = await page.evaluate(async () => {
  const j = [...jobs.values()][0];
  j.resultHtml = "<h2>One</h2><p>Last edit before changing folder.</p>";
  renderAll();
  await chooseProjectFolder();
  const disk = await window.__read(await window.__lecture("Lecture 11"), "project.json");
  return disk.jobs[0].resultHtml.includes("Last edit before changing folder");
});
check("M4  changing folder first saves the edit the folder was still missing", m4);

// M5: a first save that fails in a folder that was already there, empty,
// leaves it empty again — so the next try can use it.
const m5 = await page.evaluate(async () => {
  leaveFolderLecture();
  await (await window.__team()).getDirectoryHandle("Lecture 13", { create: true });
  els.batchName.value = "Lecture 13";
  renderAll();
  const real = writeFolderFile;
  writeFolderFile = async (dir, name, data) => { if (name === "project.json") throw new Error("disk full"); return real(dir, name, data); };
  await saveBatchToFolder();
  writeFolderFile = real;
  const dir = await window.__lecture("Lecture 13");
  const left = [];
  for await (const name of dir.keys()) left.push(name);
  await saveBatchToFolder();
  let saved = false;
  try { await dir.getFileHandle("project.json"); saved = true; } catch {}
  return { left, saved };
});
check("M5  a failed first save into an empty folder leaves it empty, and trying again works", m5.left.length === 0 && m5.saved, JSON.stringify(m5));

check("Z  no console errors or CSP violations", problems.length === 0, problems.join(" | "));

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
