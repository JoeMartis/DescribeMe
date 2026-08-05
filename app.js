"use strict";

const SYSTEM_PROMPT = `ROLE: You are an accessibility specialist writing extended descriptions of STEM
lecture slides for blind and low-vision learners who use screen readers. Your
description must give them the same information and instructional takeaway a
sighted student gets — not merely how the slide looks.

INPUT: The slide image is attached to this message.

TASK: Produce a single block of semantic HTML that reads aloud clearly, in
logical teaching order.

Structure and order
- Open with one sentence stating what the slide covers and its role in the lecture.
- Then describe elements in the order needed to build understanding, not
  necessarily top-to-bottom.
- Mirror the slide's structure with headings (<h2>/<h3>); group related points
  in <ul>/<ol>.

Equations and symbols
- Render every equation in MathML so screen readers can parse it, then
  immediately follow it with a plain-language reading in a <span class="sr-note">
  (e.g., "read as: the integral from 0 to infinity of e to the minus x squared, dx").
- Spell out each symbol and abbreviation the first time it appears.

Figures, diagrams, processes
- Wrap each in <figure> with a <figcaption>.
- Name the figure type first (graph, circuit, free-body diagram, reaction
  pathway…), then describe its components, their spatial or logical
  relationships, and the direction of any flow or sequence.

Data and charts
- Give chart type, axes, ranges, and units, then the trend and the specific
  values that matter. Put discrete data in a <table> with <th> headers.

Color, emphasis, callouts
- Describe these by function, not appearance: what a highlighted term signifies,
  not that it is red or boxed.

Constraints
- Do not include <img> elements. You have no URL for the original slide to
  reference, so any <img> you emit will render as a broken image — describe
  everything visual in text, inside <figure>/<figcaption> where appropriate.
- Include only what is present on the slide. Do not infer values, add outside
  facts, or editorialize. This includes summary framing: do not append a
  "Takeaways," "Key points," or similar synthesis section unless the slide
  itself displays one — restate what's visibly there, not your own reading
  of what it means or why it matters.
- Do not interpret the meaning or lesson of a graph. Report only what is
  visible on the graph.
- Be complete but not padded; every sentence should carry information a sighted
  viewer would receive.
- Do not start with "This slide" but rather name the type of visual diagram on the slide, such as "A line graph shows…" "A diagram illustrates." etc.

OUTPUT: Return the HTML only — no code fences, no commentary — ready to embed, using semantic screen-reader-friendly markup.`;

// ---------- Tunables ----------

// The Anthropic API rejects any single image over ~5 MB — but images are
// optimized in-browser before upload, so this caps what gets *sent*, not
// what the user may *pick*: an oversized file is downscaled or re-encoded
// into range, not turned away at the door.
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Intake sanity ceiling — the only outright rejection. Decoding a file this
// size in a browser tab is a memory problem regardless of what the API
// would say, and no real slide export comes close.
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_BATCH_SIZE = 25;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const ANTHROPIC_VERSION = "2023-06-01";

// This app is wired specifically to MIT Parley, which proxies the Anthropic
// Messages API. All requests go to this host — there is no user-configurable
// base URL.
const API_BASE_URL = "https://parley.api.mit.edu";

// Claude doesn't benefit from image dimensions beyond roughly this on the long
// edge — it downsamples internally. Resizing client-side before upload cuts
// the base64 payload (and the image tokens billed) substantially on typical
// slide screenshots/exports without any loss of legibility.
const MAX_IMAGE_EDGE = 1568;
const RESIZE_JPEG_QUALITY = 0.85;

const MAX_ATTEMPTS = 4; // 1 initial try + 3 retries
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 15000;

const USER_INSTRUCTION_TEXT =
  "Describe this STEM lecture slide following the system instructions.";

// Cheapest to most expensive; also the order "redo with a stronger model"
// steps through.
const MODEL_LADDER = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"];
const MODEL_SHORT_NAMES = {
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-opus-5": "Opus 5",
};

// ---------- Verbosity ----------
//
// Appended to SYSTEM_PROMPT rather than replacing any of it — the structural
// requirements (semantic HTML, MathML + plain-language readings, figure/
// figcaption, real tables, "include only what's on the slide") always apply
// regardless of verbosity. Only how much elaboration to add on top of that
// minimum changes.

const VERBOSITY_LEVELS = [
  {
    label: "Concise",
    hint: "Just the essentials — the fewest sentences that still convey the same instructional takeaway.",
    estimatedOutputTokens: 350,
    promptAddendum:
      "VERBOSITY: Concise. Cover only what's necessary to give the same instructional takeaway a " +
      "sighted student gets, in as few sentences as accomplishes that. Combine related points instead " +
      "of listing them separately where nothing is lost. Don't restate in prose what structure already " +
      "conveys — e.g. don't narrate a table's contents if the table itself is included.",
  },
  {
    label: "Standard",
    hint: "The default balance: complete but not padded.",
    estimatedOutputTokens: 650,
    promptAddendum: "",
  },
  {
    label: "Detailed",
    hint: "More depth on relationships, sequence, and spatial layout — still only what's on the slide.",
    estimatedOutputTokens: 950,
    promptAddendum:
      "VERBOSITY: Detailed. Describe spatial layout, relationships between elements, and sequence or " +
      "flow in more depth than the minimum requires. Use only what is visibly present on the slide — " +
      "more thorough is not license to infer values, add outside facts, or editorialize.",
  },
];

// Per-slide revision instructions. These are appended after the verbosity
// addendum, so the structural requirements still apply — a revision only
// changes how much elaboration this one slide gets.
const REVISIONS = {
  more:
    "REVISION: A previous description of this slide was too sparse. Describe spatial layout, " +
    "relationships between elements, and sequence or flow more thoroughly this time. Still use only " +
    "what is visibly present on the slide.",
  less:
    "REVISION: A previous description of this slide was longer than it needed to be. Convey the same " +
    "instructional takeaway in noticeably fewer sentences, combining related points where nothing is lost.",
  textOnly:
    "REVISION: This slide's only content is on-screen text (e.g. a title or section-divider slide) — " +
    "there is nothing to describe visually. Override the instructions above: skip the opening summary " +
    "sentence and any narrative description, and return only a semantic transcription of the text " +
    "exactly as it appears, in reading order (a heading for a title, paragraphs or a list for any " +
    "subtitle or supporting lines). Do not add framing like \"This slide reads\" or restate that it's a " +
    "title slide.",
};

function currentVerbosity() {
  // Default is Concise (index 0), not Standard — even Opus, the most
  // succinct model, still needed the "Shorter" revision at least once at
  // Standard, and Sonnet/Haiku typically needed it twice.
  return VERBOSITY_LEVELS[Number(els.verbosity.value)] || VERBOSITY_LEVELS[0];
}

function buildSystemPrompt(verbosity, revision) {
  let prompt = SYSTEM_PROMPT;
  if (verbosity.promptAddendum) prompt += `\n\n${verbosity.promptAddendum}`;
  if (revision) prompt += `\n\n${revision}`;
  return prompt;
}

// ---------- Cost estimation (rough, display only — see below) ----------
//
// These numbers exist to give a ballpark per-slide cost in the model picker,
// nothing more. Real usage depends on the actual image and how much text
// Claude writes, and can vary a lot from slide to slide. Do not use this for
// budgeting — it's an estimate for one hypothetical "average" slide.

// Anthropic's published rule of thumb for image tokens is roughly
// (width_px * height_px) / 750. Uploads are capped at MAX_IMAGE_EDGE on the
// long edge, so a representative resized slide (~1568x980, a common
// presentation aspect ratio) lands around this many image tokens. Many
// slides are smaller than the cap and would cost less than this estimate.
const ESTIMATED_IMAGE_TOKENS = 1200;

const TOKENS_PER_WORD_ESTIMATE = 1.35;

function estimateTokenCount(text) {
  return Math.round(text.trim().split(/\s+/).filter(Boolean).length * TOKENS_PER_WORD_ESTIMATE);
}

// Pricing in USD per million tokens, matching the model picker below.
// Per Parley's own cost guidance (parley-docs.mit.edu/cost-guidance) — these
// are the rates actually configured in Parley, which can differ from
// Anthropic's first-party API pricing.
const MODEL_PRICING = {
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "claude-sonnet-5": { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  "claude-opus-5": { inputPerMTok: 5.0, outputPerMTok: 25.0 },
};

function estimateAverageSlideCostUsd(modelId, verbosity) {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) return null;
  const inputTokens =
    estimateTokenCount(SYSTEM_PROMPT) +
    estimateTokenCount(verbosity.promptAddendum) +
    estimateTokenCount(USER_INSTRUCTION_TEXT) +
    ESTIMATED_IMAGE_TOKENS;
  return (
    (inputTokens / 1e6) * pricing.inputPerMTok +
    (verbosity.estimatedOutputTokens / 1e6) * pricing.outputPerMTok
  );
}

function formatUsd(amount, decimals) {
  // These are sub-cent amounts — show enough precision to distinguish the
  // three models without implying false accuracy.
  return `$${amount.toFixed(decimals == null ? 4 : decimals)}`;
}

// ---------- Elements ----------

const els = {
  // onboarding
  onboarding: document.getElementById("onboarding"),
  onboardKey: document.getElementById("onboardKey"),
  onboardKeyToggle: document.getElementById("onboardKeyToggle"),
  onboardModels: document.getElementById("onboardModels"),
  onboardError: document.getElementById("onboardError"),
  onboardStart: document.getElementById("onboardStart"),
  onboardSkip: document.getElementById("onboardSkip"),
  versionBadgeOnboard: document.getElementById("versionBadgeOnboard"),

  // shell
  app: document.getElementById("app"),
  versionBadge: document.getElementById("versionBadge"),
  batchName: document.getElementById("batchName"),
  batchSummary: document.getElementById("batchSummary"),
  settingsChip: document.getElementById("settingsChip"),
  settingsChipDot: document.getElementById("settingsChipDot"),
  settingsChipLabel: document.getElementById("settingsChipLabel"),
  costChipLabel: document.getElementById("costChipLabel"),
  costChipValue: document.getElementById("costChipValue"),
  settingsBtn: document.getElementById("settingsBtn"),
  exportBtn: document.getElementById("exportBtn"),
  exportBtnLabel: document.getElementById("exportBtnLabel"),

  // rail
  railList: document.getElementById("railList"),
  railEmpty: document.getElementById("railEmpty"),
  railFileInput: document.getElementById("railFileInput"),
  newBatchBtn: document.getElementById("newBatchBtn"),
  progressCard: document.getElementById("progressCard"),
  progressLabel: document.getElementById("progressLabel"),
  progressFill: document.getElementById("progressFill"),
  stopBtn: document.getElementById("stopBtn"),
  describeCard: document.getElementById("describeCard"),
  describeCardTitle: document.getElementById("describeCardTitle"),
  describeCardBody: document.getElementById("describeCardBody"),
  describeBtn: document.getElementById("describeBtn"),

  // detail
  detail: document.getElementById("detail"),
  emptyState: document.getElementById("emptyState"),
  detailPane: document.getElementById("detailPane"),
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  statusMessage: document.getElementById("statusMessage"),
  errorMessage: document.getElementById("errorMessage"),

  // settings dialog
  settingsDialog: document.getElementById("settingsDialog"),
  settingsClose: document.getElementById("settingsClose"),
  settingsDone: document.getElementById("settingsDone"),
  apiKey: document.getElementById("apiKey"),
  toggleKeyVisibility: document.getElementById("toggleKeyVisibility"),
  model: document.getElementById("model"),
  verbosity: document.getElementById("verbosity"),
  verbosityValue: document.getElementById("verbosityValue"),
  verbosityHint: document.getElementById("verbosityHint"),
  systemPromptPreview: document.getElementById("systemPromptPreview"),
  clearStoredKey: document.getElementById("clearStoredKey"),

  // projects dialog
  projectsBtn: document.getElementById("projectsBtn"),
  projectsDialog: document.getElementById("projectsDialog"),
  projectsClose: document.getElementById("projectsClose"),
  saveProjectBtn: document.getElementById("saveProjectBtn"),
  importProjectInput: document.getElementById("importProjectInput"),
  saveProjectHint: document.getElementById("saveProjectHint"),
  projectsError: document.getElementById("projectsError"),
  projectList: document.getElementById("projectList"),
  projectsEmpty: document.getElementById("projectsEmpty"),

  // templates
  railRowTemplate: document.getElementById("railRowTemplate"),
  detailTemplate: document.getElementById("detailTemplate"),
};

/** @type {Map<string, object>} jobId -> job */
const jobs = new Map();
let jobSeq = 0;
let batchRunning = false;
let cancelRequested = false;
let selectedJobId = null;
let editMode = null; // null | "preview" | "source" — which edit surface, if any, is live
let currentProjectId = null; // set once the batch is saved as / loaded from a project
const inFlightControllers = new Set();

// ---------- Settings persistence ----------

const STORAGE_KEYS = {
  key: "describeme.apiKey",
  model: "describeme.model",
  verbosity: "describeme.verbosity",
  persistence: "describeme.keyPersistence",
  onboarded: "describeme.onboarded",
};

// Not user-configurable — a fixed middle ground between processing a batch
// serially (slow) and firing every request at once (likely to trip rate
// limits and waste retries).
const BATCH_CONCURRENCY = 3;

function loadSettings() {
  const persistence = localStorage.getItem(STORAGE_KEYS.persistence) || "none";
  const radio = document.querySelector(
    `input[name="keyPersistence"][value="${persistence}"]`
  );
  if (radio) radio.checked = true;

  // Gate ALL three fields on persistence mode, not just the key — reading
  // model/verbosity unconditionally meant a stale value left over in storage
  // (e.g. from before switching persistence back to "none") would silently
  // reapply on every load regardless of the user's current choice.
  if (persistence === "local" || persistence === "session") {
    const store = persistence === "local" ? localStorage : sessionStorage;
    els.apiKey.value = store.getItem(STORAGE_KEYS.key) || "";

    const savedModel = store.getItem(STORAGE_KEYS.model);
    if (savedModel) els.model.value = savedModel;

    const savedVerbosity = store.getItem(STORAGE_KEYS.verbosity);
    if (savedVerbosity) els.verbosity.value = savedVerbosity;
  }
}

function currentPersistenceMode() {
  const checked = document.querySelector('input[name="keyPersistence"]:checked');
  return checked ? checked.value : "none";
}

function persistSettings() {
  const mode = currentPersistenceMode();

  [STORAGE_KEYS.key, STORAGE_KEYS.model, STORAGE_KEYS.verbosity].forEach((k) => {
    localStorage.removeItem(k);
    sessionStorage.removeItem(k);
  });

  localStorage.setItem(STORAGE_KEYS.persistence, mode);

  if (mode === "local" || mode === "session") {
    const store = mode === "local" ? localStorage : sessionStorage;
    store.setItem(STORAGE_KEYS.key, els.apiKey.value);
    store.setItem(STORAGE_KEYS.model, els.model.value);
    store.setItem(STORAGE_KEYS.verbosity, els.verbosity.value);
  }
}

document
  .querySelectorAll('input[name="keyPersistence"]')
  .forEach((radio) => radio.addEventListener("change", persistSettings));

els.apiKey.addEventListener("input", () => {
  persistSettings();
  updateControls();
  // The no-key alert has exactly one cause, so the moment a key is typed
  // the complaint is stale — clear it instead of leaving it up until the
  // next describe attempt happens to overwrite it.
  if (els.apiKey.value.trim() && els.errorMessage.textContent === NO_KEY_ERROR) {
    setError("");
  }
});
els.model.addEventListener("input", () => {
  persistSettings();
  updateControls();
});
els.verbosity.addEventListener("input", () => {
  updateVerbosityDisplay();
  persistSettings();
  updateControls();
});

els.clearStoredKey.addEventListener("click", () => {
  [STORAGE_KEYS.key, STORAGE_KEYS.model, STORAGE_KEYS.verbosity].forEach((k) => {
    localStorage.removeItem(k);
    sessionStorage.removeItem(k);
  });
  localStorage.removeItem(STORAGE_KEYS.persistence);
  els.apiKey.value = "";
  document.querySelector('input[name="keyPersistence"][value="none"]').checked = true;
  setStatus("Stored API key cleared.");
  updateControls();
});

// ---------- Settings dialog ----------

function openSettings() {
  els.settingsDialog.showModal();
  els.apiKey.focus();
}
function closeSettings() {
  els.settingsDialog.close();
}
els.settingsBtn.addEventListener("click", openSettings);
els.settingsChip.addEventListener("click", openSettings);
els.settingsClose.addEventListener("click", closeSettings);
els.settingsDone.addEventListener("click", closeSettings);
els.settingsDialog.addEventListener("close", updateControls);

function wireKeyVisibilityToggle(input, button) {
  button.addEventListener("click", () => {
    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";
    button.setAttribute("aria-pressed", String(isPassword));
    button.textContent = isPassword ? "Hide" : "Show";
  });
}
wireKeyVisibilityToggle(els.apiKey, els.toggleKeyVisibility);
wireKeyVisibilityToggle(els.onboardKey, els.onboardKeyToggle);

// ---------- Status / error helpers ----------

function setStatus(message) {
  els.statusMessage.textContent = message;
}

const NO_KEY_ERROR = "Add your MIT Parley API key in settings first.";

function setError(message) {
  if (message) {
    els.errorMessage.textContent = message;
    els.errorMessage.hidden = false;
  } else {
    els.errorMessage.textContent = "";
    els.errorMessage.hidden = true;
  }
}

// ---------- Onboarding ----------

function showOnboarding() {
  els.onboarding.hidden = false;
  els.app.hidden = true;
  els.onboardKey.focus();
}

function showApp() {
  els.onboarding.hidden = true;
  els.app.hidden = false;
}

els.onboardStart.addEventListener("click", () => {
  const key = els.onboardKey.value.trim();
  if (!key) {
    els.onboardError.textContent = "Enter your MIT Parley key to continue, or choose “I'll do this later”.";
    els.onboardError.hidden = false;
    els.onboardKey.focus();
    return;
  }
  els.onboardError.hidden = true;

  const persistence =
    document.querySelector('input[name="onboardPersistence"]:checked')?.value || "local";
  const model =
    document.querySelector('input[name="onboardModel"]:checked')?.value || "claude-sonnet-5";

  els.apiKey.value = key;
  els.model.value = model;
  const radio = document.querySelector(`input[name="keyPersistence"][value="${persistence}"]`);
  if (radio) radio.checked = true;

  persistSettings();
  localStorage.setItem(STORAGE_KEYS.onboarded, "1");
  finishOnboarding();
});

els.onboardSkip.addEventListener("click", () => {
  localStorage.setItem(STORAGE_KEYS.onboarded, "1");
  finishOnboarding();
});

function finishOnboarding() {
  showApp();
  updateVerbosityDisplay();
  updateControls();
  els.fileInput.focus();
}

function annotateOnboardingCosts() {
  const verbosity = VERBOSITY_LEVELS[0]; // matches the default verbosity below
  els.onboardModels.querySelectorAll("[data-model-cost]").forEach((span) => {
    const cost = estimateAverageSlideCostUsd(span.dataset.modelCost, verbosity);
    if (cost != null) span.textContent = formatUsd(cost);
  });
}

// ---------- Image loading & client-side optimization ----------

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode that image."));
    img.src = src;
  });
}

/**
 * Load a file and, if it's larger than what the model can usefully see,
 * downscale + recompress it in-browser. This is the main lever for making
 * each API call cheaper and faster: fewer pixels means fewer image tokens
 * billed and a smaller request body, with no loss of legibility for slide
 * content since Claude downsamples large images internally anyway.
 */
async function prepareImageForUpload(file) {
  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImageElement(dataUrl);
  const longestEdge = Math.max(img.naturalWidth, img.naturalHeight);

  const needsResize = longestEdge > MAX_IMAGE_EDGE;
  // Even a small-dimension file can carry a payload over the API's
  // per-image cap (a many-frame GIF, an uncompressed PNG). That's a reason
  // to re-encode it at the same dimensions, not to reject it.
  const needsRecompress = !needsResize && file.size > MAX_FILE_BYTES;

  if (!needsResize && !needsRecompress) {
    return {
      dataUrl,
      base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      mediaType: file.type,
      width: img.naturalWidth,
      height: img.naturalHeight,
      resized: false,
    };
  }

  const scale = needsResize ? MAX_IMAGE_EDGE / longestEdge : 1;
  const targetW = Math.max(1, Math.round(img.naturalWidth * scale));
  const targetH = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  // Flatten onto white first: JPEG has no alpha channel, and slide exports
  // with transparent backgrounds would otherwise turn black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.drawImage(img, 0, 0, targetW, targetH);

  const mediaType = "image/jpeg";
  const resizedDataUrl = canvas.toDataURL(mediaType, RESIZE_JPEG_QUALITY);
  const base64 = resizedDataUrl.slice(resizedDataUrl.indexOf(",") + 1);

  // A 1568px JPEG at this quality is well under the cap in practice; this
  // is a backstop so a pathological case fails with a clear message here
  // instead of an opaque API rejection later.
  if (base64.length * 0.75 > MAX_FILE_BYTES) {
    throw new Error(
      `Still over the API's 5 MB per-image limit after re-encoding (${(
        (base64.length * 0.75) /
        (1024 * 1024)
      ).toFixed(1)} MB).`
    );
  }

  return {
    dataUrl: resizedDataUrl,
    base64,
    mediaType,
    width: targetW,
    height: targetH,
    resized: needsResize,
    recompressed: needsRecompress,
    originalWidth: img.naturalWidth,
    originalHeight: img.naturalHeight,
  };
}

// ---------- Queue management ----------

function makeJobId() {
  jobSeq += 1;
  return `job-${jobSeq}`;
}

function jobList() {
  return [...jobs.values()];
}

function selectedJob() {
  return selectedJobId ? jobs.get(selectedJobId) || null : null;
}

/** One place that decides how a job's state reads, for the rail and the detail pane. */
function jobStatusMeta(job) {
  switch (job.state) {
    case "pending":
      // "Queued" only means something once a batch is actually running and
      // waiting to reach this job — otherwise it's just sitting there ready
      // to go, same as a slide added moments ago with no batch in progress.
      return batchRunning
        ? { state: "pending", text: "Queued", dot: "" }
        : { state: "pending", text: "Ready", dot: "" };
    case "describing":
      return {
        state: "describing",
        text: job.attempt > 1 ? `Describing… (retry ${job.attempt - 1})` : "Describing…",
        dot: "dot-describing",
      };
    case "done":
      return job.approved
        ? { state: "approved", text: "Approved", dot: "dot-approved" }
        : { state: "done", text: "Described · needs review", dot: "dot-done" };
    case "error":
      return batchRunning
        ? { state: "error", text: "Failed · retry once this batch finishes", dot: "dot-error" }
        : { state: "error", text: "Failed · needs a retry", dot: "dot-error" };
    case "canceled":
      return { state: "canceled", text: "Canceled", dot: "" };
    case "invalid":
      return { state: "invalid", text: "Couldn't load this image", dot: "dot-error" };
    default:
      return { state: job.state, text: job.state, dot: "" };
  }
}

function createRailRow(job) {
  const fragment = els.railRowTemplate.content.cloneNode(true);
  const li = fragment.querySelector("li");
  li.dataset.jobId = job.id;
  const row = li.querySelector(".rail-row");
  row.dataset.jobId = job.id;

  const thumb = row.querySelector(".rail-thumb");
  thumb.src = job.previewDataUrl;
  thumb.alt = "";

  row.querySelector(".rail-name").textContent = job.name;
  row.addEventListener("click", () => selectJob(job.id));

  li.querySelector(".js-move-up").addEventListener("click", () => moveJob(job.id, -1));
  li.querySelector(".js-move-down").addEventListener("click", () => moveJob(job.id, 1));
  wireRowDrag(li, job.id);

  els.railList.appendChild(fragment);
  job.railEl = els.railList.querySelector(`.rail-row[data-job-id="${job.id}"]`);
  renderRailRow(job);
}

// ---------- Reordering ----------
// Order is meaningful: it drives prev/next review, "Slide N of M", and the
// export. jobs is an insertion-ordered Map, so reordering means rebuilding
// its entries; the rail <li>s are then moved (appendChild relocates a live
// node) rather than recreated, keeping thumbnails and listeners intact.

/** Move a job to an absolute position in the batch (clamped). */
function moveJobTo(jobId, targetIndex) {
  const entries = [...jobs.entries()];
  const from = entries.findIndex(([id]) => id === jobId);
  if (from === -1) return;
  const to = Math.max(0, Math.min(entries.length - 1, targetIndex));
  if (to === from) return;
  const [entry] = entries.splice(from, 1);
  entries.splice(to, 0, entry);
  jobs.clear();
  for (const [id, job] of entries) jobs.set(id, job);
  for (const [, job] of entries) {
    const li = job.railEl?.closest("li");
    if (li) els.railList.appendChild(li);
  }
  renderAll();
}

/** Move a job one step up (-1) or down (+1). */
function moveJob(jobId, delta) {
  const ids = [...jobs.keys()];
  const idx = ids.indexOf(jobId);
  if (idx === -1) return;
  moveJobTo(jobId, idx + delta);
}

let draggedJobId = null;

function wireRowDrag(li, jobId) {
  li.addEventListener("dragstart", (e) => {
    draggedJobId = jobId;
    li.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    // Some browsers need data set for the drag to start at all.
    e.dataTransfer.setData("text/plain", jobId);
  });
  li.addEventListener("dragend", () => {
    draggedJobId = null;
    li.classList.remove("is-dragging");
  });
  li.addEventListener("dragover", (e) => {
    if (!draggedJobId || draggedJobId === jobId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  li.addEventListener("drop", (e) => {
    if (!draggedJobId || draggedJobId === jobId) return;
    e.preventDefault();
    // Land before or after this row depending on which half was dropped on.
    const rect = li.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    const ids = [...jobs.keys()].filter((id) => id !== draggedJobId);
    const base = ids.indexOf(jobId);
    moveJobTo(draggedJobId, after ? base + 1 : base);
  });
}

function renderRailRow(job) {
  const row = job.railEl;
  if (!row) return;
  const meta = jobStatusMeta(job);
  row.dataset.state = meta.state;
  row.querySelector(".rail-status").textContent = meta.text;
  row.setAttribute("aria-current", String(job.id === selectedJobId));
  const dot = row.querySelector(".dot");
  dot.className = `dot ${meta.dot}`;
  row.setAttribute(
    "aria-label",
    `${job.name} — ${meta.text}${job.id === selectedJobId ? ", currently open" : ""}`
  );
}

function renderRail() {
  jobs.forEach(renderRailRow);
  els.railEmpty.hidden = jobs.size > 0;

  const list = jobList();
  list.forEach((job, i) => {
    const li = job.railEl?.closest("li");
    if (!li) return;
    const up = li.querySelector(".js-move-up");
    const down = li.querySelector(".js-move-down");
    up.disabled = i === 0;
    down.disabled = i === list.length - 1;
    up.setAttribute("aria-label", `Move ${job.name} earlier (position ${i + 1} of ${list.length})`);
    down.setAttribute("aria-label", `Move ${job.name} later (position ${i + 1} of ${list.length})`);
  });
}

/** Land any in-progress edit before an action that re-renders or re-runs
    the slide. renderDetail's editMode guard exists to protect an edit from
    being clobbered mid-typing — but that same guard means any action taken
    while editing plays out invisibly, and a later save would overwrite the
    action's newer result with stale preview content. */
function commitPendingEdit() {
  if (editMode === "preview") commitEdit();
  else if (editMode === "source") commitSourceEdit();
}

function selectJob(jobId, options) {
  if (!jobs.has(jobId)) return;
  commitPendingEdit();
  selectedJobId = jobId;
  renderRail();
  renderDetail();
  if (options && options.focusDetail) els.detail.focus();
}

function selectRelative(delta) {
  const list = jobList();
  if (list.length === 0) return;
  const idx = list.findIndex((j) => j.id === selectedJobId);
  const next = list[Math.min(list.length - 1, Math.max(0, (idx === -1 ? 0 : idx) + delta))];
  if (next) selectJob(next.id);
}

function selectNextUnapproved() {
  const next = jobList().find((j) => j.state === "done" && !j.approved);
  if (next) selectJob(next.id);
  else selectRelative(1);
}

async function addFiles(fileList) {
  setError("");
  const files = Array.from(fileList);
  if (files.length === 0) return;

  let room = MAX_BATCH_SIZE - jobs.size;
  if (room <= 0) {
    setError(`You already have the maximum of ${MAX_BATCH_SIZE} images queued.`);
    return;
  }

  // Validate every file first, independent of the batch-size cap — slicing
  // the list by position before checking validity would let an earlier
  // invalid file silently consume a slot that a later valid one needed,
  // dropping it with no message at all.
  const messages = [];
  let skippedForRoom = 0;

  for (const file of files) {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      messages.push(`Skipped "${file.name}": unsupported type "${file.type || "unknown"}".`);
      continue;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      messages.push(
        `Skipped "${file.name}": ${(file.size / (1024 * 1024)).toFixed(0)} MB is too large to decode in the browser (50 MB ceiling).`
      );
      continue;
    }
    if (room <= 0) {
      skippedForRoom += 1;
      continue;
    }
    room -= 1;

    const job = {
      id: makeJobId(),
      name: file.name,
      state: "pending",
      attempt: 0,
      error: null,
      resultHtml: "",
      resultText: "",
      approved: false,
      edited: false,
      history: [],
      durationMs: null,
      usedModel: null,
      railEl: null,
    };
    jobs.set(job.id, job);

    try {
      const prepared = await prepareImageForUpload(file);
      Object.assign(job, prepared, { previewDataUrl: prepared.dataUrl });
      createRailRow(job);
    } catch (err) {
      // The file itself couldn't be decoded (corrupt/unsupported) — this is
      // permanent, not something retrying the API call would fix, so it gets
      // its own terminal state and is excluded from the runnable batch.
      job.state = "invalid";
      job.error = err.message || String(err);
      job.previewDataUrl =
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
        );
      createRailRow(job);
    }

    if (!selectedJobId) selectedJobId = job.id;
  }

  if (skippedForRoom > 0) {
    messages.push(
      `${skippedForRoom} file(s) skipped — batches are capped at ${MAX_BATCH_SIZE} images.`
    );
  }
  if (messages.length > 0) setError(messages.join(" "));

  maybeNameBatch();
  renderAll();
}

/** Default the batch name to whatever the filenames have in common. */
function maybeNameBatch() {
  if (els.batchName.dataset.userNamed === "1") return;
  const names = jobList().map((j) => j.name);
  if (names.length === 0) return;
  let prefix = names[0].replace(/\.[^.]+$/, "");
  for (const name of names.slice(1)) {
    const bare = name.replace(/\.[^.]+$/, "");
    let i = 0;
    while (i < prefix.length && i < bare.length && prefix[i] === bare[i]) i += 1;
    prefix = prefix.slice(0, i);
  }
  prefix = prefix.replace(/[-_\s]+$/, "").trim();
  els.batchName.value = prefix.length >= 3 ? prefix : "Untitled batch";
}

els.batchName.addEventListener("input", () => {
  els.batchName.dataset.userNamed = "1";
});

/** Clear every slide to start over — the batch-wide sibling of removeJob.
    As destructive as a reload, so it always confirms first; the message
    is sharper when descriptions (i.e. money and review time) are at stake. */
function newBatch() {
  if (jobs.size === 0 || batchRunning) return;
  const described = jobList().some((j) => j.state === "done");
  const ok = window.confirm(
    described
      ? "Start a new batch? The current slides and their descriptions go away unless you've saved or exported them."
      : `Start a new batch? This clears the ${jobs.size} queued slide${jobs.size === 1 ? "" : "s"}.`
  );
  if (!ok) return;
  jobs.clear();
  els.railList.replaceChildren();
  selectedJobId = null;
  editMode = null;
  currentProjectId = null;
  els.batchName.value = "Untitled batch";
  delete els.batchName.dataset.userNamed;
  setError("");
  renderAll();
  setStatus("Batch cleared — drop the next lecture's slides in.");
}

function removeJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.state === "describing") return; // don't remove mid-flight
  // Removing the slide being edited discards the edit with it — otherwise
  // editMode stays set and blocks renderDetail from ever updating again.
  if (jobId === selectedJobId) editMode = null;
  const list = jobList();
  const idx = list.findIndex((j) => j.id === jobId);
  job.railEl?.closest("li")?.remove();
  jobs.delete(jobId);
  if (selectedJobId === jobId) {
    const remaining = jobList();
    selectedJobId = remaining.length ? (remaining[Math.min(idx, remaining.length - 1)].id) : null;
  }
  renderAll();
}

/** Describe (or re-describe) exactly this one slide — never pulls in any
 *  other queued job the way handing it to runBatch()'s runnableJobs() would. */
async function describeSingleJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || batchRunning) return;
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    setError(NO_KEY_ERROR);
    openSettings();
    return;
  }
  const model = els.model.value.trim() || "claude-sonnet-5";
  const verbosity = currentVerbosity();

  setError("");
  job.attempt = 0;
  job.error = null;
  batchRunning = true;
  updateControls();

  await describeOne(job, { apiKey, model, verbosity });

  batchRunning = false;
  renderAll();
}

// ---------- Header, controls, status ----------

function counts() {
  const c = { pending: 0, describing: 0, done: 0, error: 0, canceled: 0, invalid: 0, approved: 0 };
  jobs.forEach((j) => {
    c[j.state] = (c[j.state] || 0) + 1;
    if (j.state === "done" && j.approved) c.approved += 1;
  });
  return c;
}

function runnableJobs() {
  return jobList().filter(
    (j) => j.state === "pending" || j.state === "error" || j.state === "canceled"
  );
}

function updateControls() {
  const c = counts();
  const hasApiKey = !!els.apiKey.value.trim();
  const runnable = runnableJobs();

  // Header — batch summary
  if (jobs.size === 0) {
    els.batchSummary.textContent = "No slides yet";
  } else {
    const parts = [`${jobs.size} slide${jobs.size === 1 ? "" : "s"}`];
    if (batchRunning) {
      parts.push(`${c.done} described`, `${c.describing} in progress`, `${c.pending} queued`);
    } else {
      parts.push(`${c.done} described`);
      if (c.approved) parts.push(`${c.approved} approved`);
      if (c.error) parts.push(`${c.error} need a retry`);
      if (c.pending) parts.push(`${c.pending} queued`);
    }
    els.batchSummary.textContent = parts.join(" · ");
  }

  // Header — settings chip
  const modelName = MODEL_SHORT_NAMES[els.model.value] || els.model.value;
  els.settingsChipLabel.textContent = hasApiKey
    ? `Key set · ${modelName} · ${currentVerbosity().label}`
    : "No key yet — add one";
  els.settingsChipDot.className = hasApiKey ? "chip-dot" : "chip-dot chip-dot-warn";

  // Header — cost estimate. Always an estimate; never a bill.
  const perSlide = estimateAverageSlideCostUsd(els.model.value, currentVerbosity());
  if (perSlide == null) {
    els.costChipValue.textContent = "—";
  } else if (jobs.size === 0) {
    els.costChipLabel.textContent = "Est. per slide";
    els.costChipValue.textContent = formatUsd(perSlide);
  } else {
    els.costChipLabel.textContent = "Est. this batch";
    els.costChipValue.textContent = `≈ ${formatUsd(perSlide * jobs.size, 3)}`;
  }

  // Header — export
  els.exportBtn.disabled = c.approved === 0;
  els.exportBtnLabel.textContent =
    c.approved === 0
      ? "Export as .zip"
      : `Export ${c.approved} approved as .zip`;

  // Rail — head
  els.newBatchBtn.hidden = jobs.size === 0;
  els.newBatchBtn.disabled = batchRunning;

  // Rail — describe card
  els.describeCard.hidden = jobs.size === 0 || batchRunning;
  els.describeBtn.disabled = batchRunning || !hasApiKey || runnable.length === 0;
  if (!els.describeCard.hidden) {
    if (runnable.length > 0) {
      els.describeCardTitle.textContent = hasApiKey
        ? `${runnable.length} slide${runnable.length === 1 ? "" : "s"} ready to describe.`
        : "Add your API key to start.";
      els.describeCardBody.textContent = hasApiKey
        ? "Three at a time, retrying quietly. You can review the finished ones while the rest run."
        : "The key lives in your browser only — open settings from the header.";
      els.describeBtn.textContent = `Describe ${runnable.length === jobs.size ? "all" : runnable.length}`;
    } else {
      els.describeCardTitle.textContent = `All ${jobs.size} described.`;
      els.describeCardBody.textContent = `${c.approved} approved, ${
        c.done - c.approved
      } waiting on you. Approving is what puts a slide in the export.`;
      els.describeBtn.textContent = "Review next unapproved";
      els.describeBtn.disabled = c.done - c.approved === 0;
    }
  }

  // Empty state vs detail
  const hasSelection = !!selectedJob();
  els.emptyState.hidden = jobs.size > 0;
  els.detailPane.hidden = !hasSelection;
}

function updateOverallStatus() {
  if (jobs.size === 0) {
    if (!batchRunning) setStatus("");
    return;
  }
  const c = counts();

  if (batchRunning) {
    setStatus(
      `Describing… ${c.done} done, ${c.describing} in progress, ` +
        `${c.pending} queued${c.error ? `, ${c.error} failed` : ""}.`
    );
  } else if (c.done > 0 || c.error > 0 || c.invalid > 0) {
    const parts = [`${c.done} of ${jobs.size} described`];
    if (c.approved) parts.push(`${c.approved} approved`);
    if (c.error) parts.push(`${c.error} failed`);
    if (c.canceled) parts.push(`${c.canceled} canceled`);
    if (c.invalid) parts.push(`${c.invalid} couldn't be loaded`);
    setStatus(parts.join(", ") + ".");
  }
}

function renderAll() {
  renderRail();
  renderDetail();
  updateControls();
  updateOverallStatus();
}

/** Called whenever one job's state changes. */
function renderJobState(job) {
  renderRailRow(job);
  if (job.id === selectedJobId) renderDetail();
  updateControls();
  updateOverallStatus();
}

// ---------- Detail pane ----------

function renderDetail() {
  const job = selectedJob();
  if (!job) {
    els.detailPane.replaceChildren();
    els.detailPane.hidden = true;
    return;
  }
  if (editMode) return; // never clobber an in-progress edit

  const list = jobList();
  const idx = list.findIndex((j) => j.id === job.id);
  const frag = els.detailTemplate.content.cloneNode(true);
  const q = (sel) => frag.querySelector(sel);

  q(".js-kicker").textContent = `Slide ${idx + 1} of ${list.length} · ${job.name}`;
  const prevBtn = q(".js-prev");
  const nextBtn = q(".js-next");
  prevBtn.disabled = idx <= 0;
  nextBtn.disabled = idx >= list.length - 1;
  prevBtn.addEventListener("click", () => selectRelative(-1));
  nextBtn.addEventListener("click", () => selectRelative(1));

  const img = q(".js-slide-img");
  img.src = job.previewDataUrl;
  img.alt = "";

  const metaBits = [];
  if (job.resized) {
    metaBits.push(
      `Resized ${job.originalWidth}×${job.originalHeight} → ${job.width}×${job.height} before upload`
    );
  } else if (job.recompressed) {
    metaBits.push(`Re-encoded as JPEG before upload — the original was over the API's 5 MB image limit`);
  } else if (job.width) {
    metaBits.push(`${job.width}×${job.height}, sent unmodified`);
  }
  if (job.usedModel) metaBits.push(MODEL_SHORT_NAMES[job.usedModel] || job.usedModel);
  if (job.durationMs) metaBits.push(`${(job.durationMs / 1000).toFixed(1)}s`);
  q(".js-slide-meta").textContent = metaBits.join(" · ");

  const described = job.state === "done" && job.resultHtml;

  if (described) {
    // Refine actions
    const refine = q(".js-refine");
    refine.hidden = false;
    q(".js-refine-detail").addEventListener("click", () => refineJob(job.id, "more"));
    q(".js-refine-short").addEventListener("click", () => refineJob(job.id, "less"));
    q(".js-refine-textonly").addEventListener("click", () => refineJob(job.id, "textOnly"));
    const strongerBtn = q(".js-refine-model");
    const stronger = strongerModel(job.usedModel || els.model.value);
    if (stronger) {
      strongerBtn.textContent = `Redo with ${MODEL_SHORT_NAMES[stronger]}`;
      strongerBtn.addEventListener("click", () => refineJob(job.id, null, stronger));
    } else {
      strongerBtn.hidden = true;
    }

    // Description
    q(".js-desc-head").hidden = false;
    const tag = q(".js-tag");
    tag.textContent = job.approved ? "Approved" : "Needs your review";
    tag.className = `tag ${job.approved ? "tag-approved" : "tag-review"}`;

    const words = job.resultText.trim().split(/\s+/).filter(Boolean).length;
    const features = [];
    if (/<math/i.test(job.resultHtml)) features.push("MathML");
    const figures = (job.resultHtml.match(/<figure/gi) || []).length;
    if (figures) features.push(`${figures} figure${figures === 1 ? "" : "s"}`);
    const tables = (job.resultHtml.match(/<table/gi) || []).length;
    if (tables) features.push(`${tables} table${tables === 1 ? "" : "s"}`);
    if (job.edited) features.push("edited by you");
    q(".js-desc-meta").textContent = [`${words} words`, ...features].join(" · ");

    const desc = q(".js-desc");
    desc.hidden = false;
    const preview = q(".js-preview");
    preview.innerHTML = job.resultHtml;
    preview.setAttribute("aria-label", `Description of ${job.name}`);

    const editBtn = q(".js-edit");
    editBtn.addEventListener("click", () => toggleEdit(job.id));

    // Formatting toolbar (visible only while editing). mousedown is
    // prevented so clicking a tool never steals the selection from the
    // editable preview — the command needs that selection to apply.
    const toolbar = q(".js-edit-toolbar");
    toolbar.addEventListener("mousedown", (e) => e.preventDefault());
    toolbar.addEventListener("click", (e) => {
      const tool = e.target.closest("[data-cmd], [data-block]");
      if (!tool || editMode !== "preview") return;
      if (tool.dataset.block) {
        document.execCommand("formatBlock", false, `<${tool.dataset.block}>`);
      } else {
        document.execCommand(tool.dataset.cmd, false, null);
      }
      els.detailPane.querySelector(".js-preview")?.focus();
    });

    const undoBtn = q(".js-undo");
    undoBtn.hidden = job.history.length === 0;
    if (job.history.length > 0) {
      undoBtn.addEventListener("click", () => undoRevision(job.id));
    }

    q(".js-copy-html").addEventListener("click", (e) =>
      copyToClipboard(job.resultHtml, e.currentTarget, "HTML")
    );
    q(".js-copy-text").addEventListener("click", (e) =>
      copyToClipboard(job.resultText, e.currentTarget, "text")
    );
    q(".js-remove").addEventListener("click", () => removeJob(job.id));

    const source = q(".js-source");
    source.hidden = false;
    q(".js-source-code").value = job.resultHtml;
    q(".js-edit-source").addEventListener("click", () => toggleSourceEdit(job.id));

    const bar = q(".js-approve-bar");
    bar.hidden = false;
    q(".js-approve-copy").textContent = job.approved
      ? "Approved — it's in the export. Un-approve if you spot something."
      : "Reads well? Approving adds it to the export and opens the next slide that needs you.";
    const approveBtn = q(".js-approve");
    q(".js-approve-label").textContent = job.approved ? "Un-approve" : "Approve & next";
    if (job.approved) approveBtn.classList.remove("btn-approve");
    approveBtn.addEventListener("click", () => toggleApprove(job.id));
  } else {
    // Pending / running / failed / invalid
    const pane = q(".js-pending");
    pane.hidden = false;
    const title = q(".js-pending-title");
    const body = q(".js-pending-body");
    const detail = q(".js-pending-detail");
    const primary = q(".js-pending-primary");
    const remove = q(".js-pending-remove");

    remove.disabled = job.state === "describing";
    remove.addEventListener("click", () => removeJob(job.id));

    // A per-slide action (describeSingleJob) is a no-op while a batch run
    // owns the shared apiKey/model/verbosity + inFlightControllers state, but
    // the button doesn't know that on its own — so any state below that would
    // otherwise offer one has to be told the batch has first claim.
    if (job.state === "describing") {
      title.textContent = "Describing this slide…";
      body.textContent =
        job.attempt > 1
          ? `Attempt ${job.attempt} — the last one hit a rate limit or a hiccup, so it's backing off and trying again.`
          : "Claude is reading the slide now. You can review other slides while this runs.";
      primary.hidden = true;
    } else if (job.state === "invalid") {
      title.textContent = "This image couldn't be read.";
      body.textContent =
        "The file is corrupt or in a format the browser can't decode, so there's nothing to send. Re-export it and add it again.";
      detail.hidden = false;
      detail.textContent = job.error || "unknown error";
      primary.hidden = true;
    } else if (batchRunning) {
      title.textContent = "Queued.";
      body.textContent = "Waiting for other slides in this batch to finish first.";
      primary.hidden = true;
    } else if (job.state === "error") {
      title.textContent = "This one didn't come back.";
      body.textContent =
        "MIT Parley returned an error after four tries. Waiting a moment and retrying usually clears a rate limit.";
      detail.hidden = false;
      detail.textContent = job.error || "unknown error";
      primary.textContent = "Retry this slide";
      primary.addEventListener("click", () => describeSingleJob(job.id));
    } else if (job.state === "canceled") {
      title.textContent = "Stopped before this one ran.";
      body.textContent = "Nothing was sent for this slide, so nothing was charged.";
      primary.textContent = "Describe this slide";
      primary.addEventListener("click", () => describeSingleJob(job.id));
    } else {
      title.textContent = "Not described yet.";
      body.textContent = job.resized
        ? `Ready to go — resized to ${job.width}×${job.height} so the request stays small.`
        : "Ready to go.";
      primary.textContent = "Describe this slide";
      primary.addEventListener("click", () => describeSingleJob(job.id));
    }
  }

  // renderDetail rebuilds the whole template, so <details> would snap shut on
  // every re-render — including right after saving a source edit, where the
  // panel is exactly what the user is looking at.
  const sourceWasOpen = els.detailPane.querySelector(".js-source")?.open;
  const newSource = frag.querySelector(".js-source");
  if (newSource && sourceWasOpen) newSource.open = true;

  els.detailPane.replaceChildren(frag);
  els.detailPane.hidden = false;
}

// ---------- Approve & edit ----------

function toggleApprove(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.state !== "done") return;
  commitPendingEdit(); // approve what's on screen, not the pre-edit version
  job.approved = !job.approved;
  renderRailRow(job);
  updateControls();
  updateOverallStatus();
  if (job.approved) {
    setStatus(`${job.name} approved.`);
    selectNextUnapproved();
  } else {
    renderDetail();
  }
}

function toggleEdit(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  // Commit the other surface FIRST: its commit rebuilds the whole detail
  // pane, so any node captured before it would be detached from the DOM
  // and setting contenteditable on it would do nothing visible.
  if (editMode === "source") commitSourceEdit();

  const preview = els.detailPane.querySelector(".js-preview");
  const label = els.detailPane.querySelector(".js-edit-label");
  if (!preview) return;

  if (editMode !== "preview") {
    editMode = "preview";
    preview.setAttribute("contenteditable", "true");
    // Formatting must come out as tags (<b>, <i>) — inline styles would be
    // stripped by the sanitizer on save, silently losing the formatting.
    document.execCommand("styleWithCSS", false, "false");
    const toolbar = els.detailPane.querySelector(".js-edit-toolbar");
    if (toolbar) toolbar.hidden = false;
    preview.focus();
    if (label) label.textContent = "Save changes";
  } else {
    commitEdit();
  }
}

/** Re-sanitize whatever the user typed before it becomes the stored result. */
function commitEdit() {
  const job = selectedJob();
  const preview = els.detailPane.querySelector(".js-preview");
  if (!job || !preview) {
    editMode = null;
    return;
  }
  const fragment = sanitizeHtmlFragment(preview.innerHTML);
  job.history.push({ html: job.resultHtml, text: job.resultText });
  const holder = document.createElement("div");
  holder.appendChild(fragment.cloneNode(true));
  job.resultHtml = holder.innerHTML;
  job.resultText = domFragmentToText(fragment);
  job.edited = true;
  editMode = null;
  preview.removeAttribute("contenteditable");
  renderDetail();
  updateControls();
  setStatus(`Your edits to ${job.name} were saved.`);
}

/** Raw-source counterpart to toggleEdit/commitEdit — the only way to fix a
    mistagged element, since contenteditable on the rendered preview can
    change text and formatting but never a tag name. */
function toggleSourceEdit(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  // Commit the other surface FIRST — its commit rebuilds the pane, so the
  // textarea must be queried after, or readOnly lands on a detached node.
  if (editMode === "preview") commitEdit();

  const textarea = els.detailPane.querySelector(".js-source-code");
  const label = els.detailPane.querySelector(".js-edit-source-label");
  if (!textarea) return;

  if (editMode !== "source") {
    editMode = "source";
    textarea.readOnly = false;
    textarea.focus();
    if (label) label.textContent = "Save source";
  } else {
    commitSourceEdit();
  }
}

/** Re-sanitize the raw HTML the user typed before it becomes the stored
    result — the browser's own HTML parser (inside sanitizeHtmlFragment)
    tolerates the same malformed/unclosed markup it always would. */
function commitSourceEdit() {
  const job = selectedJob();
  const textarea = els.detailPane.querySelector(".js-source-code");
  if (!job || !textarea) {
    editMode = null;
    return;
  }
  const fragment = sanitizeHtmlFragment(textarea.value);
  job.history.push({ html: job.resultHtml, text: job.resultText });
  const holder = document.createElement("div");
  holder.appendChild(fragment.cloneNode(true));
  job.resultHtml = holder.innerHTML;
  job.resultText = domFragmentToText(fragment);
  job.edited = true;
  editMode = null;
  textarea.readOnly = true;
  renderDetail();
  updateControls();
  setStatus(`Your edits to ${job.name} were saved.`);
}

function undoRevision(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.history.length === 0) return;
  // An uncommitted edit commits first (pushing onto history), so "undo"
  // then pops that same entry — i.e. undoing mid-edit undoes the edit,
  // instead of invisibly reverting underneath the editor.
  commitPendingEdit();
  const previous = job.history.pop();
  job.resultHtml = previous.html;
  job.resultText = previous.text;
  renderJobState(job);
  setStatus(`Reverted ${job.name} to the previous description.`);
}

// ---------- File input / drag & drop ----------

els.newBatchBtn.addEventListener("click", newBatch);

[els.fileInput, els.railFileInput].forEach((input) => {
  input.addEventListener("change", (e) => {
    addFiles(e.target.files);
    input.value = "";
  });
});

["dragenter", "dragover"].forEach((evt) => {
  els.app.addEventListener(evt, (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    els.dropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((evt) => {
  els.app.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropZone.classList.remove("dragover");
  });
});

els.app.addEventListener("drop", (e) => {
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    addFiles(e.dataTransfer.files);
  }
});

// ---------- Keyboard review ----------

function typingInFormField(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (els.settingsDialog.open || els.projectsDialog.open || !els.onboarding.hidden) return;
  if (typingInFormField(e.target)) return;
  if (jobs.size === 0) return;

  if (e.key === "ArrowRight") {
    e.preventDefault();
    selectRelative(1);
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    selectRelative(-1);
  } else if (e.key === "a" || e.key === "A") {
    const job = selectedJob();
    if (job && job.state === "done") {
      e.preventDefault();
      toggleApprove(job.id);
    }
  }
});

// ---------- Batch processing ----------

els.describeBtn.addEventListener("click", () => {
  if (runnableJobs().length === 0) {
    selectNextUnapproved();
    return;
  }
  runBatch();
});

els.stopBtn.addEventListener("click", () => {
  cancelRequested = true;
  els.stopBtn.disabled = true;
  setStatus("Stopping — finishing in-flight requests…");
  inFlightControllers.forEach((c) => c.abort());
});

function strongerModel(modelId) {
  const idx = MODEL_LADDER.indexOf(modelId);
  if (idx === -1 || idx === MODEL_LADDER.length - 1) return null;
  return MODEL_LADDER[idx + 1];
}

async function runBatch() {
  if (batchRunning) return;
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    setError(NO_KEY_ERROR);
    openSettings();
    return;
  }

  const runnable = runnableJobs();
  if (runnable.length === 0) return;

  const model = els.model.value.trim() || "claude-sonnet-5";
  const verbosity = currentVerbosity();

  setError("");
  batchRunning = true;
  cancelRequested = false;
  els.stopBtn.disabled = false;
  els.progressCard.hidden = false;
  // renderAll (not just updateControls) so every not-yet-picked-up rail row
  // and the detail pane immediately read "Queued" instead of their old,
  // now-stale "ready to describe" view — otherwise they won't refresh until
  // their own turn comes up.
  renderAll();

  runnable.forEach((job) => {
    job.attempt = 0;
    job.error = null;
  });

  showProgress(0, runnable.length);

  await runWithConcurrency(runnable, BATCH_CONCURRENCY, (job) =>
    describeOne(job, { apiKey, model, verbosity })
  );

  batchRunning = false;
  els.progressCard.hidden = true;
  renderAll();

  // The aggregate status line only gives a failure count; name the specific
  // slides so a screen-reader user doesn't have to hunt through the list to
  // find out which ones need a retry.
  const failed = runnable.filter((job) => job.state === "error");
  if (failed.length > 0) {
    const names = failed.map((job) => job.name).join(", ");
    setError(`Couldn't describe: ${names}. Open each one to retry it.`);
  } else {
    const firstUnapproved = jobList().find((j) => j.state === "done" && !j.approved);
    if (firstUnapproved) selectJob(firstUnapproved.id);
  }
}

/** Re-run one slide with a revision instruction and/or a stronger model. */
async function refineJob(jobId, revisionKey, overrideModel) {
  const job = jobs.get(jobId);
  if (!job || batchRunning) return;
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    setError(NO_KEY_ERROR);
    openSettings();
    return;
  }
  // Otherwise the editMode guard hides the whole revision run, and saving
  // afterward would overwrite the fresh revision with stale preview text.
  commitPendingEdit();
  job.history.push({ html: job.resultHtml, text: job.resultText });
  job.attempt = 0;
  job.error = null;
  batchRunning = true;
  updateControls();

  await describeOne(job, {
    apiKey,
    model: overrideModel || job.usedModel || els.model.value,
    verbosity: currentVerbosity(),
    revision: revisionKey ? REVISIONS[revisionKey] : "",
  });

  batchRunning = false;
  // A revision replaces an approved description, so it needs looking at again.
  job.approved = false;
  renderAll();
}

function showProgress(completed, total) {
  els.progressCard.hidden = false;
  els.progressLabel.textContent = `Describing slides — ${completed} of ${total} done`;
  els.progressFill.style.width = `${total ? Math.round((completed / total) * 100) : 0}%`;
}

async function runWithConcurrency(items, limit, worker) {
  let idx = 0;
  let completed = 0;
  const pool = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (idx < items.length) {
      if (cancelRequested) {
        const remaining = items[idx++];
        if (remaining.state === "pending" || remaining.state === "describing") {
          remaining.state = "canceled";
          renderJobState(remaining);
        }
        completed += 1;
        showProgress(completed, items.length);
        continue;
      }
      const item = items[idx++];
      await worker(item);
      completed += 1;
      showProgress(completed, items.length);
    }
  });
  await Promise.all(pool);
}

async function describeOne(job, { apiKey, model, verbosity, revision }) {
  // The job may have been removed from the queue while it was still waiting
  // for a concurrency slot — don't spend an API call describing something the
  // user already took off the list.
  if (!jobs.has(job.id)) return;

  job.state = "describing";
  job.attempt = 1;
  const startedAt = performance.now();
  renderJobState(job);

  while (true) {
    if (cancelRequested) {
      job.state = "canceled";
      renderJobState(job);
      return;
    }

    if (!jobs.has(job.id)) return; // removed while waiting out a retry backoff

    const controller = new AbortController();
    inFlightControllers.add(controller);

    try {
      const response = await fetch(`${API_BASE_URL}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: buildSystemPrompt(verbosity, revision),
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: job.mediaType,
                    data: job.base64,
                  },
                },
                {
                  type: "text",
                  text: USER_INSTRUCTION_TEXT,
                },
              ],
            },
          ],
        }),
      });

      inFlightControllers.delete(controller);

      const { raw, json: payload } = await readResponseBody(response);
      const errorMessage = () =>
        payload ? apiErrorMessage(payload, response.status) : nonJsonDiagnostic(response, raw);

      if (response.status === 429 || response.status >= 500) {
        if (job.attempt >= MAX_ATTEMPTS) {
          throw new Error(errorMessage());
        }
        const retryAfterHeader = parseFloat(response.headers.get("retry-after"));
        await sleep(retryDelay(job.attempt, retryAfterHeader));
        if (cancelRequested) {
          job.state = "canceled";
          renderJobState(job);
          return;
        }
        job.attempt += 1;
        renderJobState(job); // updates the "retry N" status for the next attempt
        continue;
      }

      if (!response.ok) {
        throw new Error(errorMessage());
      }

      if (!payload) {
        throw new Error(nonJsonDiagnostic(response, raw));
      }
      if (!Array.isArray(payload.content)) {
        throw new Error("Unexpected response shape from the API.");
      }

      const textBlock = payload.content.find((b) => b.type === "text");
      if (!textBlock || !textBlock.text) {
        throw new Error("The model did not return any text content.");
      }

      applyResult(job, textBlock.text);
      job.state = "done";
      job.usedModel = model;
      job.durationMs = performance.now() - startedAt;
      job.edited = false;
      renderJobState(job);
      return;
    } catch (err) {
      inFlightControllers.delete(controller);

      if (err.name === "AbortError") {
        job.state = "canceled";
        renderJobState(job);
        return;
      }

      if (err.name === "TypeError" && job.attempt < MAX_ATTEMPTS) {
        // Likely a transient network error — retry the same as a 5xx.
        await sleep(retryDelay(job.attempt, NaN));
        if (cancelRequested) {
          job.state = "canceled";
          renderJobState(job);
          return;
        }
        job.attempt += 1;
        renderJobState(job);
        continue;
      }

      job.state = "error";
      job.error = describeFetchError(err);
      renderJobState(job);
      return;
    }
  }
}

function retryDelay(attempt, retryAfterSeconds) {
  if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, RETRY_MAX_DELAY_MS);
  }
  const exponential = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.random() * 250;
  return Math.min(exponential + jitter, RETRY_MAX_DELAY_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiErrorMessage(payload, status) {
  if (payload && payload.error && payload.error.message) {
    return payload.error.message;
  }
  return `HTTP ${status}`;
}

/** Reads a response body once, returning both the raw text and a best-effort JSON parse. */
async function readResponseBody(response) {
  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch (_err) {
    // Not JSON — leave json as null; callers use nonJsonDiagnostic() to explain why.
  }
  return { raw, json };
}

/**
 * A non-JSON body usually means the request reached something other than the
 * API — an SSO/login redirect, a WAF or error page, or a wrong path — rather
 * than an ordinary API error. Surface enough detail to tell those apart.
 */
function nonJsonDiagnostic(response, raw) {
  const titleMatch = raw.match(/<title[^>]*>\s*([^<]+?)\s*<\/title>/i);
  const contentType = response.headers.get("content-type") || "an unknown content type";
  const redirected = response.redirected ? ` (redirected to ${response.url})` : "";
  const titlePart = titleMatch ? ` — page title: "${titleMatch[1]}"` : "";
  return (
    `MIT Parley returned HTTP ${response.status} with ${contentType} instead of JSON${redirected}` +
    `${titlePart}. The request likely reached a login page or an error page rather than the API — ` +
    `double-check the API key, and if this keeps happening, ask MIT IT whether this endpoint requires ` +
    `something other than a direct browser request.`
  );
}

function describeFetchError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (msg === "Failed to fetch") {
    return (
      `Could not reach ${API_BASE_URL} — the browser blocked or failed the request before getting a ` +
      `response. This is usually either no network connection, or MIT Parley not allowing cross-origin ` +
      `(CORS) requests from ${location.origin}. If your key works from a terminal but not here, ask MIT ` +
      `IT to enable browser (CORS) access from this origin.`
    );
  }
  return msg;
}

// ---------- Rendering & sanitizing results ----------

function sanitizeHtmlFragment(html) {
  const trimmed = html
    .trim()
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/```$/, "");

  const template = document.createElement("template");
  template.innerHTML = trimmed;

  const DISALLOWED_TAGS = new Set([
    "SCRIPT",
    "IFRAME",
    "OBJECT",
    "EMBED",
    "LINK",
    "STYLE",
    "FORM",
    "META",
    "BASE",
    // <template>'s content lives in a detached DocumentFragment
    // (element.content) that querySelectorAll never descends into — anything
    // nested inside one, however dangerous, would pass through completely
    // unexamined. There's no legitimate reason for the model's output to
    // contain one.
    "TEMPLATE",
    // SVG's declarative animation elements (<animate>, <set>, ...) can
    // rewrite an attribute — including href/src — *after* this sanitizer has
    // already approved it, once the fragment is live in the DOM. The model
    // is never asked to produce SVG, so removing the whole subtree costs
    // nothing and closes that (and any other SVG-specific surface) at once,
    // rather than trying to enumerate every dangerous SVG sub-feature.
    "SVG",
  ]);

  // Allowlists, not denylists, for anything that can carry a URL or arbitrary
  // CSS: this app renders text derived from an uploaded image, so a
  // maliciously-crafted slide (e.g. hidden text meant as a prompt injection)
  // could in principle steer the model into emitting attacker-chosen markup.
  // The model is never asked to produce links or styling, so being strict
  // here costs nothing legitimate.
  const SAFE_HREF_SCHEME_RE = /^(https?:|mailto:)/i;
  // No https?: here to match the img-src CSP directive, which only allows
  // 'self' and data:. The model is only ever given a base64 upload to
  // describe — it has no image URLs to legitimately reference.
  const SAFE_SRC_SCHEME_RE = /^data:image\//i;

  function sanitizeUrlAttribute(el, attrName, schemeRe) {
    const value = el.getAttribute(attrName).trim();
    if (value === "" || value.startsWith("#")) return; // empty or same-page fragment
    if (schemeRe.test(value)) return;
    el.removeAttribute(attrName);
  }

  const walk = (node) => {
    [...node.querySelectorAll("*")].forEach((el) => {
      // Foreign-content elements (SVG/MathML, e.g. an <svg><script>) keep
      // their tagName's original case instead of the uppercase HTML normally
      // gets — normalize before checking, or a namespaced element with the
      // same local name silently skips this check.
      if (DISALLOWED_TAGS.has(el.tagName.toUpperCase())) {
        el.remove();
        return;
      }
      [...el.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || name === "style" || name === "target") {
          el.removeAttribute(attr.name);
        }
        // The editable preview is contenteditable; don't let that attribute
        // survive into a saved description or an export.
        if (name === "contenteditable") el.removeAttribute(attr.name);
      });
      if (el.hasAttribute("href")) sanitizeUrlAttribute(el, "href", SAFE_HREF_SCHEME_RE);
      if (el.hasAttribute("src")) sanitizeUrlAttribute(el, "src", SAFE_SRC_SCHEME_RE);
      if (el.hasAttribute("xlink:href")) sanitizeUrlAttribute(el, "xlink:href", SAFE_SRC_SCHEME_RE);

      // The model has no URL for the original slide, so a <img> only ever
      // reaches this point with a src if it hallucinated one — which the
      // scheme allowlist above then strips. Rather than leave a broken-image
      // icon in an accessibility-focused description, drop the element
      // entirely once it has nothing valid to show.
      if (el.tagName === "IMG" && !el.getAttribute("src")) {
        el.remove();
      }
    });
  };

  walk(template.content);
  return template.content;
}

function domFragmentToText(fragment) {
  const clone = fragment.cloneNode(true);
  clone.querySelectorAll("math").forEach((m) => m.remove());

  const BLOCK_TAGS = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "H1", "H2", "H3", "H4", "H5", "H6",
    "UL", "OL", "LI", "FIGURE", "FIGCAPTION", "TABLE", "TR", "BR",
  ]);

  let out = "";
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const isBlock = BLOCK_TAGS.has(node.tagName);
    node.childNodes.forEach(visit);
    if (isBlock) out += "\n";
    else if (node.tagName === "SPAN" || node.tagName === "TH" || node.tagName === "TD") out += " ";
  };

  clone.childNodes.forEach(visit);

  return out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
    .join("\n")
    .trim();
}

function applyResult(job, rawHtml) {
  const fragment = sanitizeHtmlFragment(rawHtml);
  const holder = document.createElement("div");
  holder.appendChild(fragment.cloneNode(true));
  job.resultHtml = holder.innerHTML;
  job.resultText = domFragmentToText(fragment);
}

// ---------- Copy buttons ----------

async function copyToClipboard(text, button, label) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = "Copied!";
    setTimeout(() => {
      button.textContent = original;
    }, 1500);
  } catch (err) {
    setError(`Could not copy ${label} to clipboard: ${err.message}`);
  }
}

// ---------- Export: a store-only .zip, built by hand ----------
//
// The page's CSP forbids third-party scripts, so there's no JSZip to reach
// for — and there's no need for one. These are small HTML text files; storing
// them uncompressed keeps the writer to a CRC table and three record layouts.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZipBlob(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const now = new Date();
  const dosTime =
    ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate =
    (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 filenames
    lv.setUint16(8, 0, true); // stored, no compression
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((total, c) => total + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, eocd], { type: "application/zip" });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeFileStem(name, taken) {
  let stem = name
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!stem) stem = "slide";
  let candidate = stem;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${stem}-${n}`;
    n += 1;
  }
  taken.add(candidate);
  return candidate;
}

// Optional styling for whoever embeds these fragments. The fragments
// themselves carry no classes beyond .sr-note and no inline styles, so they
// inherit the host page's typography unless someone opts into this.
function exportApproved() {
  const approved = jobList().filter((j) => j.state === "done" && j.approved);
  if (approved.length === 0) return;

  const batch = els.batchName.value.trim() || "Untitled batch";
  const taken = new Set();
  const entries = approved.map((job) => ({ job, stem: safeFileStem(job.name, taken) }));

  const files = entries.map(({ job, stem }) => ({
    name: `${stem}.html`,
    content: `${job.resultHtml}\n`,
  }));

  files.push({
    name: "index.html",
    content:
      `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
      `<title>${escapeHtml(batch)} — slide descriptions</title>\n</head>\n<body>\n` +
      `<h1>${escapeHtml(batch)}</h1>\n` +
      `<p>${approved.length} approved slide description${approved.length === 1 ? "" : "s"}, ` +
      `generated with DescribeMe. Each is also in this folder as its own HTML fragment, ` +
      `ready to paste beside the slide.</p>\n` +
      entries
        .map(
          ({ job, stem }) =>
            `<section>\n<h2>${escapeHtml(job.name)} <small>(<a href="${stem}.html">${stem}.html</a>)</small></h2>\n` +
            `${job.resultHtml}\n</section>`
        )
        .join("\n") +
      `\n</body>\n</html>\n`,
  });

  const blob = buildZipBlob(files);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFileStem(batch, new Set())}-descriptions.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  setStatus(`Exported ${approved.length} approved description${approved.length === 1 ? "" : "s"}.`);
}

els.exportBtn.addEventListener("click", exportApproved);

// ---------- Verbosity display & version badge ----------

function updateVerbosityDisplay() {
  const verbosity = currentVerbosity();
  els.verbosityValue.textContent = verbosity.label;
  els.verbosityHint.textContent = verbosity.hint;
  els.verbosity.setAttribute("aria-valuetext", verbosity.label);
  annotateModelOptionsWithCostEstimates();
  els.systemPromptPreview.textContent = buildSystemPrompt(verbosity);
}

function annotateModelOptionsWithCostEstimates() {
  const verbosity = currentVerbosity();
  [...els.model.options].forEach((option) => {
    // Cache the pre-estimate label so repeated calls (verbosity changes)
    // don't keep appending onto the previous estimate.
    if (!option.dataset.baseLabel) option.dataset.baseLabel = option.textContent;
    const cost = estimateAverageSlideCostUsd(option.value, verbosity);
    if (cost == null) return;
    option.textContent = `${option.dataset.baseLabel} — est. ${formatUsd(cost)}/slide`;
  });
}

function renderVersionBadge() {
  // version.js (generated by a git pre-commit hook, see .githooks/pre-commit)
  // sets window.APP_VERSION to a number that increases with every commit.
  // It won't exist for a fresh checkout that hasn't committed yet.
  const label = window.APP_VERSION ? `v${window.APP_VERSION}` : "dev";
  els.versionBadge.textContent = label;
  els.versionBadgeOnboard.textContent = label;
}

// ---------- Easter egg ----------
// Five quick clicks on the header wordmark and a visitor swings by. The
// container is aria-hidden with pointer-events: none, so he can't intercept
// a click, a tab stop, or a screen reader — strictly a treat for whoever
// idly clicks the logo.
(() => {
  const egg = document.getElementById("monkeyEgg");
  const brand = document.querySelector(".app-header .brand");
  if (!egg || !brand) return;
  let clicks = 0;
  let lastClick = 0;
  brand.addEventListener("click", () => {
    const now = Date.now();
    clicks = now - lastClick < 1200 ? clicks + 1 : 1;
    lastClick = now;
    if (clicks < 5 || !egg.hidden) return;
    clicks = 0;
    egg.hidden = false;
    egg.classList.add("is-up");
    egg.addEventListener(
      "animationend",
      () => {
        egg.classList.remove("is-up");
        egg.hidden = true;
      },
      { once: true }
    );
  });
})();

// ---------- Projects (IndexedDB persistence) ----------
// Everything about the current batch — slide images (as the already-downscaled
// JPEG data URLs), descriptions, edits, history, approvals, the batch name —
// saved in this browser's IndexedDB so a batch can be reopened later.
// localStorage can't hold this (a 25-slide project is ~10 MB of images);
// IndexedDB's quota comfortably can.

const PROJECT_DB_NAME = "describeme";
const PROJECT_DB_VERSION = 1;
const PROJECT_STORE = "projects";

function openProjectDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PROJECT_DB_NAME, PROJECT_DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(PROJECT_STORE)) {
        req.result.createObjectStore(PROJECT_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Couldn't open project storage."));
  });
}

async function projectStoreRequest(mode, run) {
  const db = await openProjectDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PROJECT_STORE, mode);
      const req = run(tx.objectStore(PROJECT_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Project storage failed."));
    });
  } finally {
    db.close();
  }
}

function setProjectsError(message) {
  els.projectsError.textContent = message;
  els.projectsError.hidden = !message;
}

function serializeProject() {
  return {
    id: currentProjectId || `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: els.batchName.value.trim() || "Untitled batch",
    savedAt: Date.now(),
    jobs: jobList().map((job) => ({
      name: job.name,
      // A slide caught mid-request goes back to pending — a restored project
      // has no request in flight to resume.
      state: job.state === "describing" ? "pending" : job.state,
      error: job.error,
      resultHtml: job.resultHtml,
      resultText: job.resultText,
      approved: job.approved,
      edited: job.edited,
      history: job.history,
      durationMs: job.durationMs,
      usedModel: job.usedModel,
      dataUrl: job.previewDataUrl,
      mediaType: job.mediaType,
      width: job.width,
      height: job.height,
      resized: job.resized,
      recompressed: job.recompressed,
      originalWidth: job.originalWidth,
      originalHeight: job.originalHeight,
    })),
  };
}

function loadProjectRecord(record) {
  jobs.clear();
  els.railList.replaceChildren();
  selectedJobId = null;
  editMode = null;

  for (const saved of record.jobs) {
    const job = {
      id: makeJobId(),
      attempt: 0,
      railEl: null,
      ...saved,
      previewDataUrl: saved.dataUrl,
      base64:
        saved.dataUrl && saved.dataUrl.startsWith("data:") && saved.dataUrl.includes(",")
          ? saved.dataUrl.slice(saved.dataUrl.indexOf(",") + 1)
          : null,
    };
    delete job.dataUrl;
    jobs.set(job.id, job);
    createRailRow(job);
    if (!selectedJobId) selectedJobId = job.id;
  }

  els.batchName.value = record.name;
  els.batchName.dataset.userNamed = "1"; // don't auto-rename a named project
  currentProjectId = record.id;
  renderAll();
}

async function saveCurrentProject() {
  if (jobs.size === 0) {
    setProjectsError("Nothing to save yet — add some slides first.");
    return;
  }
  if (batchRunning) {
    setProjectsError("Wait for the current batch to finish before saving.");
    return;
  }
  setProjectsError("");
  const record = serializeProject();
  try {
    await projectStoreRequest("readwrite", (store) => store.put(record));
  } catch (err) {
    setProjectsError(`Couldn't save: ${err.message || err}`);
    return;
  }
  currentProjectId = record.id;
  setStatus(`Project "${record.name}" saved.`);
  await refreshProjectList();
}

async function openProject(id) {
  if (batchRunning) {
    setProjectsError("Wait for the current batch to finish first.");
    return;
  }
  let record;
  try {
    record = await projectStoreRequest("readonly", (store) => store.get(id));
  } catch (err) {
    setProjectsError(`Couldn't open: ${err.message || err}`);
    return;
  }
  if (!record) {
    setProjectsError("That project is gone — it may have been deleted in another tab.");
    await refreshProjectList();
    return;
  }
  if (jobs.size > 0 && currentProjectId !== record.id) {
    const ok = window.confirm(
      "Opening a project replaces the current batch. Anything unsaved is lost. Continue?"
    );
    if (!ok) return;
  }
  loadProjectRecord(record);
  els.projectsDialog.close();
  setStatus(`Project "${record.name}" opened.`);
}

async function deleteProject(id, name) {
  const ok = window.confirm(`Delete the saved project "${name}"? This can't be undone.`);
  if (!ok) return;
  try {
    await projectStoreRequest("readwrite", (store) => store.delete(id));
  } catch (err) {
    setProjectsError(`Couldn't delete: ${err.message || err}`);
    return;
  }
  if (currentProjectId === id) currentProjectId = null;
  await refreshProjectList();
}

async function refreshProjectList() {
  let records;
  try {
    records = await projectStoreRequest("readonly", (store) => store.getAll());
  } catch (err) {
    setProjectsError(`Couldn't read saved projects: ${err.message || err}`);
    return;
  }
  records.sort((a, b) => b.savedAt - a.savedAt);

  els.projectList.replaceChildren();
  els.projectsEmpty.hidden = records.length > 0;

  for (const record of records) {
    const li = document.createElement("li");
    li.className = "project-row";

    const text = document.createElement("div");
    text.className = "project-text";
    const name = document.createElement("p");
    name.className = "project-name";
    name.textContent = record.name;
    const meta = document.createElement("p");
    meta.className = "project-meta";
    const described = record.jobs.filter((j) => j.state === "done").length;
    const bits = [
      `${record.jobs.length} slide${record.jobs.length === 1 ? "" : "s"}`,
      `${described} described`,
      new Date(record.savedAt).toLocaleString(),
    ];
    if (record.id === currentProjectId) bits.push("open now");
    meta.textContent = bits.join(" · ");
    text.append(name, meta);

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn btn-small";
    openBtn.textContent = "Open";
    openBtn.addEventListener("click", () => openProject(record.id));

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "btn btn-small";
    exportBtn.textContent = "Export";
    exportBtn.addEventListener("click", () => exportProjectRecord(record));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-small btn-ghost";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => deleteProject(record.id, record.name));

    li.append(text, openBtn, exportBtn, deleteBtn);
    els.projectList.appendChild(li);
  }
}

// --- Import / export: a project as a plain .json file, so a batch can move
// to another device or person. The export is just the stored record; the
// import treats the file as untrusted (anyone can hand-edit JSON, and "sent
// to someone else" is exactly the case where that matters) — every
// description is re-run through the same sanitizer as model output, and
// every field is validated rather than copied.

const PROJECT_FILE_FORMAT = "describeme-project";

function exportProjectRecord(record) {
  const payload = {
    format: PROJECT_FILE_FORMAT,
    version: 1,
    name: record.name,
    savedAt: record.savedAt,
    jobs: record.jobs,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFileStem(record.name, new Set())}.describeme.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  setStatus(`Exported "${record.name}" as a project file.`);
}

/** Validate + sanitize a parsed project file into a fresh storable record.
    Throws with a user-facing message on anything unusable. */
function importedProjectRecord(raw) {
  if (!raw || typeof raw !== "object" || raw.format !== PROJECT_FILE_FORMAT || !Array.isArray(raw.jobs)) {
    throw new Error("That doesn't look like a DescribeMe project file.");
  }
  if (raw.jobs.length === 0) throw new Error("That project file has no slides in it.");
  if (raw.jobs.length > MAX_BATCH_SIZE) {
    throw new Error(`That project has ${raw.jobs.length} slides — batches are capped at ${MAX_BATCH_SIZE}.`);
  }

  const VALID_STATES = new Set(["pending", "done", "error", "canceled", "invalid"]);
  const sanitizeToStored = (html) => {
    const fragment = sanitizeHtmlFragment(String(html || ""));
    const holder = document.createElement("div");
    holder.appendChild(fragment.cloneNode(true));
    return { html: holder.innerHTML, text: domFragmentToText(fragment) };
  };

  const jobs = raw.jobs.map((saved, i) => {
    const dataUrlOk = typeof saved.dataUrl === "string" && saved.dataUrl.startsWith("data:image/");
    const result = sanitizeToStored(saved.resultHtml);
    const state = VALID_STATES.has(saved.state) ? saved.state : "pending";
    const num = (v) => (Number.isFinite(v) ? v : null);
    return {
      name: typeof saved.name === "string" && saved.name ? saved.name : `Slide ${i + 1}`,
      state,
      error: typeof saved.error === "string" ? saved.error : null,
      resultHtml: result.html,
      resultText: result.text,
      approved: !!saved.approved && state === "done",
      edited: !!saved.edited,
      history: Array.isArray(saved.history)
        ? saved.history.map((entry) => sanitizeToStored(entry && entry.html))
        : [],
      durationMs: num(saved.durationMs),
      usedModel: MODEL_LADDER.includes(saved.usedModel) ? saved.usedModel : null,
      dataUrl: dataUrlOk
        ? saved.dataUrl
        : "data:image/svg+xml;utf8," +
          encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'),
      mediaType: ACCEPTED_TYPES.includes(saved.mediaType) ? saved.mediaType : "image/jpeg",
      width: num(saved.width),
      height: num(saved.height),
      resized: !!saved.resized,
      recompressed: !!saved.recompressed,
      originalWidth: num(saved.originalWidth),
      originalHeight: num(saved.originalHeight),
    };
  });

  return {
    // Always a fresh id — an import must never silently overwrite an existing
    // project that happens to share an id (e.g. re-importing your own export).
    id: `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Imported project",
    savedAt: Date.now(),
    jobs,
  };
}

async function importProjectFile(file) {
  setProjectsError("");
  let record;
  try {
    record = importedProjectRecord(JSON.parse(await file.text()));
  } catch (err) {
    setProjectsError(
      err instanceof SyntaxError
        ? "That file isn't valid JSON — is it really a DescribeMe project export?"
        : `Couldn't import: ${err.message || err}`
    );
    return;
  }
  try {
    await projectStoreRequest("readwrite", (store) => store.put(record));
  } catch (err) {
    setProjectsError(`Couldn't store the imported project: ${err.message || err}`);
    return;
  }
  setStatus(`Imported "${record.name}" — it's in the list, ready to open.`);
  await refreshProjectList();
}

els.projectsBtn.addEventListener("click", async () => {
  setProjectsError("");
  els.saveProjectHint.textContent =
    jobs.size === 0
      ? "Add slides to have something to save."
      : `Saves "${els.batchName.value.trim() || "Untitled batch"}" — ${jobs.size} slide${jobs.size === 1 ? "" : "s"} and every description.`;
  els.projectsDialog.showModal();
  await refreshProjectList();
});
els.projectsClose.addEventListener("click", () => els.projectsDialog.close());
els.saveProjectBtn.addEventListener("click", saveCurrentProject);
els.importProjectInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) await importProjectFile(file);
});

// ---------- Init ----------

loadSettings();
updateVerbosityDisplay();
annotateOnboardingCosts();
renderVersionBadge();

if (localStorage.getItem(STORAGE_KEYS.onboarded)) {
  showApp();
} else {
  showOnboarding();
}

renderAll();
