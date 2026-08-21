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
- MathML must be well-formed: close every tag, and give <mfrac>, <msub>,
  <msup>, <mover>, <munder> and <mroot> exactly two child elements each —
  wrap multi-token numerators, denominators and bases in <mrow>. Misnested
  markup renders as scrambled symbols for sighted readers.
- Render every equation in MathML so screen readers can parse it, then
  immediately follow it with a plain-language reading in a <span class="sr-note">
  (e.g., "read as: the integral from 0 to infinity of e to the minus x squared, dx").
- Spell out each symbol and abbreviation the first time it appears.

Figures, diagrams, processes
- Describe each in ordinary paragraphs (<p>). Do not use <figure> or
  <figcaption> — the page this is embedded in reserves those for the slide
  image itself.
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
  everything visual in text.
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

// Two hosts, chosen by the key itself — there is no user-configurable base
// URL. MIT Parley proxies the Anthropic Messages API, so the request shape
// is identical either way; an sk-ant- key routes straight to Anthropic.
const PARLEY_BASE_URL = "https://parley.api.mit.edu";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

function keyIsAnthropic(key) {
  return (key || "").trim().startsWith("sk-ant-");
}

function apiBaseFor(key) {
  return keyIsAnthropic(key) ? ANTHROPIC_BASE_URL : PARLEY_BASE_URL;
}

// Claude doesn't benefit from image dimensions beyond roughly this on the long
// edge — it downsamples internally. Resizing client-side before upload cuts
// the base64 payload (and the image tokens billed) substantially on typical
// slide screenshots/exports without any loss of legibility.
const MAX_IMAGE_EDGE = 1568;
const RESIZE_JPEG_QUALITY = 0.85;

// Width target for the optional "Resize to ~800px wide" export option —
// unrelated to MAX_IMAGE_EDGE above, which governs what gets sent to the
// API. This is about keeping the exported images page-friendly in Studio.
const EXPORT_RESIZE_WIDTH = 800;
// Higher than RESIZE_JPEG_QUALITY: that one trades quality for a cheaper,
// smaller API upload, but a learner-facing export should look as close to
// the original as reasonably possible.
const EXPORT_JPEG_QUALITY = 0.95;

// Video frames are captured at MAX_IMAGE_EDGE as JPEG rather than at the
// video's native resolution as PNG, which matters more than it looks.
// Capturing at native 1080p PNG would leave prepareImageForUpload with work
// to do, so every job would hold TWO copies — the original plus the
// downscaled upload — at roughly 0.9-1.9 MB each. Capturing at the size the
// API wants means it takes the no-op path and stores one copy, and since
// autosave rewrites every slide's bytes on a 1.5s debounce, that difference
// is the difference between a ~7 MB record and a ~45 MB one.
const CAPTURE_JPEG_QUALITY = 0.92;
const VIDEO_SKIP_SECONDS = 5;

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
    hint: "The default. Deliberately tight — the fewest sentences that still convey the same instructional takeaway.",
    estimatedOutputTokens: 250,
    // Deliberately harder-edged than the old wording: in practice every model
    // still came back a notch too long and needed one "Shorter" pass, so the
    // operative language from that revision lives here now.
    promptAddendum:
      "VERBOSITY: Concise. A screen reader delivers this linearly, so extra length is a real cost — " +
      "brevity is part of the accessibility. Convey the instructional takeaway in noticeably fewer " +
      "sentences than feels natural: combine related points where nothing is lost, prefer one plain " +
      "sentence per element over several, and cut any sentence a listener could lose without losing " +
      "information. Never restate in prose what structure already conveys — a table, list, or MathML " +
      "block that is included speaks for itself. When unsure whether a sentence earns its place, cut it.",
  },
  {
    label: "Standard",
    hint: "A fuller middle ground: complete but not padded.",
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
  // Unlike the two above, this one is not phrased as a revision of a previous
  // attempt: it is also used as the FIRST run for a slide the user has marked
  // OCR-only, where no previous description exists.
  textOnly:
    "TEXT ONLY: This slide's content is on-screen text and math — there is nothing to describe " +
    "visually. Override the instructions above: skip the opening summary sentence and any narrative " +
    "description, and return only a semantic transcription of what is written, exactly as it appears " +
    "and in reading order — a heading for a title, paragraphs or a list for supporting lines, and " +
    "MathML (with its plain-language reading) for any equation or expression. Do not add framing like " +
    "\"This slide reads\" or restate that it's a title slide.",
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
  onboardResize: document.getElementById("onboardResize"),
  onboardStart: document.getElementById("onboardStart"),
  onboardSkip: document.getElementById("onboardSkip"),
  versionBadgeOnboard: document.getElementById("versionBadgeOnboard"),

  // shell
  app: document.getElementById("app"),
  versionBadge: document.getElementById("versionBadge"),
  batchName: document.getElementById("batchName"),
  batchSummary: document.getElementById("batchSummary"),
  settingsChip: document.getElementById("settingsChip"),
  settingsChipBadge: document.getElementById("settingsChipBadge"),
  costChipLabel: document.getElementById("costChipLabel"),
  costChipValue: document.getElementById("costChipValue"),
  exportBtn: document.getElementById("exportBtn"),
  exportBtnLabel: document.getElementById("exportBtnLabel"),
  exportResize: document.getElementById("exportResize"),

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

  // video capture dialog
  videoBtn: document.getElementById("videoBtn"),
  videoBtnEmpty: document.getElementById("videoBtnEmpty"),
  videoDialog: document.getElementById("videoDialog"),
  videoClose: document.getElementById("videoClose"),
  videoInput: document.getElementById("videoInput"),
  videoFileName: document.getElementById("videoFileName"),
  transcriptBtn: document.getElementById("transcriptBtn"),
  transcriptInput: document.getElementById("transcriptInput"),
  transcriptHint: document.getElementById("transcriptHint"),
  videoStage: document.getElementById("videoStage"),
  videoEl: document.getElementById("videoEl"),
  videoPlayPause: document.getElementById("videoPlayPause"),
  videoPlayIcon: document.getElementById("videoPlayIcon"),
  videoPauseIcon: document.getElementById("videoPauseIcon"),
  videoBack: document.getElementById("videoBack"),
  videoFwd: document.getElementById("videoFwd"),
  videoScrub: document.getElementById("videoScrub"),
  videoTimeLabel: document.getElementById("videoTimeLabel"),
  videoRate: document.getElementById("videoRate"),
  videoMute: document.getElementById("videoMute"),
  videoSoundOnIcon: document.getElementById("videoSoundOnIcon"),
  videoSoundOffIcon: document.getElementById("videoSoundOffIcon"),
  videoVolume: document.getElementById("videoVolume"),
  videoCapture: document.getElementById("videoCapture"),
  videoCaptureDescribe: document.getElementById("videoCaptureDescribe"),
  videoCaptureOcr: document.getElementById("videoCaptureOcr"),
  videoCropBtn: document.getElementById("videoCropBtn"),
  videoCropOverlay: document.getElementById("videoCropOverlay"),
  videoCropRect: document.getElementById("videoCropRect"),
  videoInputLabel: document.getElementById("videoInputLabel"),
  videoError: document.getElementById("videoError"),
  videoStatus: document.getElementById("videoStatus"),

  // projects dialog
  projectsBtn: document.getElementById("projectsBtn"),
  projectsDialog: document.getElementById("projectsDialog"),
  projectsClose: document.getElementById("projectsClose"),
  saveProjectBtn: document.getElementById("saveProjectBtn"),
  importProjectInput: document.getElementById("importProjectInput"),
  saveProjectHint: document.getElementById("saveProjectHint"),
  projectsError: document.getElementById("projectsError"),
  projectsStatus: document.getElementById("projectsStatus"),
  settingsStatus: document.getElementById("settingsStatus"),
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
// What kind of run set batchRunning: "batch" (Describe all) or "single" (one
// slide's describe/retry/refine). Other pending slides are only genuinely
// "queued behind" a batch run — a single run leaves them untouched.
let runScope = null;
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
  // Not gated on the key-persistence choice below: an export preference is
  // not key material, and the default is "don't remember", so gating it
  // there would mean it never persisted for most people — the whole reason
  // it moved out of the header.
  exportResize: "describeme.exportResize",
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

  const savedResize = localStorage.getItem(STORAGE_KEYS.exportResize);
  if (savedResize !== null) els.exportResize.checked = savedResize === "1";
  // The splash shows the same choice, so it has to start from the same value
  // rather than its own markup default.
  els.onboardResize.checked = els.exportResize.checked;

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

els.exportResize.addEventListener("change", () => {
  localStorage.setItem(STORAGE_KEYS.exportResize, els.exportResize.checked ? "1" : "0");
});

els.clearStoredKey.addEventListener("click", () => {
  [STORAGE_KEYS.key, STORAGE_KEYS.model, STORAGE_KEYS.verbosity].forEach((k) => {
    localStorage.removeItem(k);
    sessionStorage.removeItem(k);
  });
  localStorage.removeItem(STORAGE_KEYS.persistence);
  els.apiKey.value = "";
  document.querySelector('input[name="keyPersistence"][value="none"]').checked = true;
  // Announced inside the dialog: showModal() makes the page's status region
  // inert, so a message there would be neither heard nor seen right now.
  els.settingsStatus.textContent = "Stored API key cleared.";
  setStatus("Stored API key cleared.");
  updateControls();
});

// ---------- Settings dialog ----------

function openSettings() {
  els.settingsStatus.textContent = ""; // don't re-announce a stale confirmation
  els.settingsDialog.showModal();
  els.apiKey.focus();
}
function closeSettings() {
  els.settingsDialog.close();
}
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

const NO_KEY_ERROR = "Add your MIT Parley or Anthropic API key in settings first.";

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
    els.onboardError.textContent = "Enter your MIT Parley or Anthropic key to continue, or choose \"I'll do this later\".";
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
  // Carried on both exits, including "I'll do this later" — the checkbox was
  // on screen either way, so unticking it and then skipping should still mean
  // something. Written straight to storage like the settings copy, since it
  // is an export preference and not key material.
  els.exportResize.checked = els.onboardResize.checked;
  localStorage.setItem(STORAGE_KEYS.exportResize, els.exportResize.checked ? "1" : "0");

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
    // The API only ever sees the resized/recompressed version above — but
    // exporting for Studio needs the untouched original bytes, since the
    // export references the image by its original filename.
    originalBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    originalMediaType: file.type,
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
      // waiting to reach this job — a single-slide run doesn't touch other
      // pending slides, so they stay "Ready".
      return batchRunning && runScope === "batch"
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
      return batchRunning && runScope === "batch"
        ? { state: "error", text: "Failed · retry once this batch finishes", dot: "dot-error" }
        : { state: "error", text: "Failed · needs a retry", dot: "dot-error" };
    case "canceled":
      return { state: "canceled", text: "Canceled", dot: "" };
    case "invalid":
      return { state: "invalid", text: "Couldn't prepare this image", dot: "dot-error" };
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
  // Otherwise renderAll below is blocked by the editMode guard and the
  // kicker/prev-next state goes stale until the edit is saved.
  commitPendingEdit();
  const [entry] = entries.splice(from, 1);
  entries.splice(to, 0, entry);
  jobs.clear();
  for (const [id, job] of entries) jobs.set(id, job);
  // Re-appending a connected <li> removes and re-inserts it, which evicts
  // keyboard focus from the chevron that was just pressed — remember it so
  // repeated moves don't dump focus to <body> after every press.
  const active = document.activeElement;
  const focusSel = active?.classList?.contains("js-move-up")
    ? ".js-move-up"
    : active?.classList?.contains("js-move-down")
      ? ".js-move-down"
      : null;
  const focusLi = focusSel ? active.closest("li") : null;
  for (const [, job] of entries) {
    const li = job.railEl?.closest("li");
    if (li) els.railList.appendChild(li);
  }
  renderAll();
  if (focusLi) {
    const preferred = focusLi.querySelector(focusSel);
    const sibling = focusLi.querySelector(
      focusSel === ".js-move-up" ? ".js-move-down" : ".js-move-up"
    );
    // The pressed chevron may have just become disabled (row reached an
    // end) — land on its sibling so the keyboard user stays in place.
    (preferred && !preferred.disabled ? preferred : sibling)?.focus();
  }
  // After renderAll: updateOverallStatus writes the batch summary to the
  // same live region, so announce the move last to win the region.
  setStatus(`${jobs.get(jobId).name} moved to position ${to + 1} of ${jobs.size}.`);
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

/**
 * @param meta extra fields merged onto every job created from this call —
 *   how a captured video frame carries its timestamp in. Applied at job
 *   creation so it survives the Object.assign of the prepared image below.
 */
async function addFiles(fileList, meta) {
  setError("");
  const all = Array.from(fileList);
  if (all.length === 0) return;

  // Transcripts are peeled off before anything image-shaped happens: they
  // don't occupy batch slots, and a full batch must not stop one attaching.
  const files = all.filter((f) => !isTranscriptFile(f));
  const transcriptNotes = [];
  for (const f of all.filter(isTranscriptFile)) {
    transcriptNotes.push(await registerWorkspaceTranscript(f));
  }
  if (files.length === 0) {
    if (transcriptNotes.length > 0) {
      // renderAll before the announcement, not after: updateOverallStatus
      // blanks the status line for an empty batch and would eat the note.
      renderAll();
      setStatus(transcriptNotes.join(" "));
    }
    return;
  }

  if (jobs.size >= MAX_BATCH_SIZE) {
    // The images are refused, but any transcript in the same drop already
    // attached — say so, or the cap error reads as the whole drop failing.
    if (transcriptNotes.length > 0) {
      renderAll();
      setStatus(transcriptNotes.join(" "));
    }
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
    // Checked live against jobs.size (not a pre-captured budget): this loop
    // awaits per file, so a second drop can interleave with this one — a
    // stale local counter would let the two together blow past the cap.
    if (jobs.size >= MAX_BATCH_SIZE) {
      skippedForRoom += 1;
      continue;
    }

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
      videoName: null,
      captureSeconds: null,
      textOnly: false,
      transcriptContext: null,
      ...meta,
    };

    // An upload named on the capture convention — <stem>_HH-MM-SS.<ext> —
    // carries its own timestamp, and pairs with a workspace transcript of
    // that stem. Only when no meta supplied one: a dialog capture already
    // knows its timestamp and its transcript, and they are authoritative.
    if (!Number.isFinite(job.captureSeconds)) {
      const stamp = timestampFromName(file.name);
      if (stamp) {
        job.captureSeconds = stamp.seconds;
        job.videoName = normalizeStem(stamp.prefix);
        const transcript = workspaceTranscripts.get(job.videoName);
        if (transcript && !job.transcriptContext) {
          job.transcriptContext = excerptFromCues(transcript.cues, stamp.seconds);
        }
      }
    }
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
  // After renderAll for the same reason as the early return above — and it
  // outranks the batch summary this once: the attachment is what just
  // happened, and the summary is back on the next render anyway.
  if (transcriptNotes.length > 0) setStatus(transcriptNotes.join(" "));
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
  markDirty();
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
  // The next batch is a different lecture until proven otherwise — a stale
  // transcript left here would silently stamp last week's speech onto any
  // name-matching upload.
  workspaceTranscripts.clear();
  els.railList.replaceChildren();
  selectedJobId = null;
  editMode = null;
  currentProjectId = null;
  els.batchName.value = "Untitled batch";
  delete els.batchName.dataset.userNamed;
  setError("");
  renderAll();
  // The New batch button itself just hid (no slides left) — without a new
  // focus target a keyboard user is dumped at the top of the document.
  els.railFileInput.focus();
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
  setStatus(
    `${job.name} removed — ${jobs.size} slide${jobs.size === 1 ? "" : "s"} left.`
  );
}

/** Describe (or re-describe) exactly this one slide — never pulls in any
 *  other queued job the way handing it to runBatch()'s runnableJobs() would. */
async function describeSingleJob(jobId, mode) {
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

  // "ocr" marks the slide text-only from here on (describeOne reads the flag,
  // so retries and model redos stay OCR); "describe" clears it; undefined —
  // the error pane's Retry — keeps whichever mode the slide already had.
  if (mode === "ocr") job.textOnly = true;
  else if (mode === "describe") job.textOnly = false;

  setError("");
  job.attempt = 0;
  job.error = null;
  batchRunning = true;
  runScope = "single";
  // Stale from a previous batch's Stop — only runBatch resets it, so without
  // this, describeOne would instantly re-cancel the slide instead of running.
  cancelRequested = false;
  renderAll();

  await describeOne(job, { apiKey, model, verbosity });

  batchRunning = false;
  runScope = null;
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
  // base64 is set once prepareImageForUpload resolves — a job still mid-decode
  // is in the Map (holding its batch slot) but has nothing to send yet, and
  // including it would fire a request with an undefined image payload.
  return jobList().filter(
    (j) =>
      (j.state === "pending" || j.state === "error" || j.state === "canceled") && j.base64
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
    if (batchRunning && runScope === "batch") {
      parts.push(`${c.done} described`, `${c.describing} in progress`, `${c.pending} queued`);
    } else {
      parts.push(`${c.done} described`);
      if (c.approved) parts.push(`${c.approved} approved`);
      if (c.error) parts.push(`${c.error} need a retry`);
      // "ready", matching the rail's wording — nothing is queued behind a
      // batch unless a batch is actually running.
      if (c.pending) parts.push(`${c.pending} ready`);
    }
    els.batchSummary.textContent = parts.join(" · ");
  }

  // Header — settings cog. It no longer has room to spell its state out, so
  // the words move to the accessible name and the tooltip and the alert
  // treatment carries it visually.
  const modelName = MODEL_SHORT_NAMES[els.model.value] || els.model.value;
  const settingsLabel = hasApiKey
    ? `Settings — key set · ${modelName} · ${currentVerbosity().label}`
    : "No API key yet — open settings";
  els.settingsChip.setAttribute("aria-label", settingsLabel);
  els.settingsChip.title = settingsLabel;
  els.settingsChip.classList.toggle("btn-alert", !hasApiKey);
  els.settingsChipBadge.hidden = hasApiKey;

  // Settings — cost estimate. Always an estimate; never a bill. Off-screen
  // until the dialog is open, but still recomputed here so it is correct the
  // moment it appears and moves live as the model and verbosity change.
  const perSlide = estimateAverageSlideCostUsd(els.model.value, currentVerbosity());
  if (perSlide == null) {
    // The label has to be reset too — otherwise an unpriced model inherits
    // whatever the last priced one wrote, e.g. "Est. this batch —".
    els.costChipLabel.textContent = "Est. per slide";
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
    const stillDecoding = jobList().some((j) => j.state === "pending" && !j.base64);
    if (runnable.length > 0) {
      els.describeCardTitle.textContent = hasApiKey
        ? `${runnable.length} slide${runnable.length === 1 ? "" : "s"} ready to describe.`
        : "Add your API key to start.";
      els.describeCardBody.textContent = hasApiKey
        ? "Three at a time, retrying quietly. You can review the finished ones while the rest run."
        : "The key lives in your browser only — open settings from the header.";
      els.describeBtn.textContent = `Describe ${runnable.length === jobs.size ? "all" : runnable.length}`;
    } else if (stillDecoding) {
      // Just-dropped files aren't runnable until their images decode — the
      // all-described branch below would briefly claim "All 0 described."
      els.describeCardTitle.textContent = "Getting slides ready…";
      els.describeCardBody.textContent = "Reading the images in your browser now.";
      els.describeBtn.textContent = "Describe all";
      els.describeBtn.disabled = true;
    } else {
      els.describeCardTitle.textContent = c.invalid
        ? `All ${c.done} readable slides described.`
        : `All ${c.done} described.`;
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

  if (batchRunning && runScope === "batch") {
    setStatus(
      `Describing… ${c.done} done, ${c.describing} in progress, ` +
        `${c.pending} queued${c.error ? `, ${c.error} failed` : ""}.`
    );
  } else if (batchRunning) {
    setStatus("Describing one slide…");
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
  markDirty();
}

/** Called whenever one job's state changes. */
function renderJobState(job) {
  renderRailRow(job);
  if (job.id === selectedJobId) renderDetail();
  updateControls();
  updateOverallStatus();
  markDirty();
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
  // Number.isFinite, not truthiness — a frame captured at 0:00 has a real
  // timestamp of 0. Pushed into metaBits rather than appended to the element:
  // the line below overwrites its textContent wholesale.
  if (Number.isFinite(job.captureSeconds)) {
    metaBits.push(`Captured at ${formatClock(job.captureSeconds)}`);
  }
  if (job.transcriptContext) metaBits.push("Transcript context attached");
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

    // Checked live on every render (so an edit that fixes the math clears
    // it) and combined with the parse-time flag, which sees damage the
    // parsed tree no longer shows.
    const arityProblems = mathmlProblems(job.resultHtml);
    const mathWarn = q(".js-math-warning");
    if (job.mathWarning || arityProblems.length > 0) {
      mathWarn.hidden = false;
      const detail = arityProblems.length > 0 ? ` (${[...new Set(arityProblems)].slice(0, 3).join(", ")})` : "";
      mathWarn.textContent =
        (job.mathWarning || "This description's equation markup is malformed and will render scrambled.") +
        detail +
        " Try Redo with a stronger model, or re-describe this slide.";
    }

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
      updateToolbarPressed();
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
    const ocrBtn = q(".js-pending-ocr");
    const remove = q(".js-pending-remove");

    ocrBtn.addEventListener("click", () => describeSingleJob(job.id, "ocr"));
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
      title.textContent = "This image can't be sent.";
      // The detail line below carries the actual reason — this state covers
      // both undecodable files and the still-over-the-API-cap backstop, so
      // the body must not claim one specific cause.
      body.textContent =
        "Something about the file itself is the problem, so retrying the request won't help — the note below says what. Re-export the slide and add it again.";
      detail.hidden = false;
      detail.textContent = job.error || "unknown error";
      primary.hidden = true;
    } else if (job.state === "error") {
      // Checked before the queued/waiting branch: a slide that already
      // failed mid-batch should show its error, not claim to be queued.
      title.textContent = "This one didn't come back.";
      // Only rate limits, server errors, and network hiccups are retried —
      // a 400/401 fails on the first attempt, and claiming "four tries" or
      // suggesting a wait would be wrong for those (bad key, bad request).
      body.textContent =
        job.attempt >= MAX_ATTEMPTS
          ? "The API returned an error after four tries. Waiting a moment and retrying usually clears a rate limit."
          : "The API rejected this request outright — the error below says why. Fix the cause (often the API key) before retrying.";
      detail.hidden = false;
      detail.textContent = job.error || "unknown error";
      primary.textContent = "Retry this slide";
      primary.hidden = batchRunning; // retry is a no-op while a run owns the shared state
      primary.addEventListener("click", () => describeSingleJob(job.id));
    } else if (job.state === "canceled") {
      // Also checked before the queued/waiting branch — while a stopped
      // batch drains, an already-canceled slide shouldn't claim "Queued".
      if (job.requestSent) {
        title.textContent = "Stopped mid-request.";
        body.textContent =
          "The request for this slide had already been sent when you stopped, so it may still be billed — but nothing came back, and nothing was kept.";
      } else {
        title.textContent = "Stopped before this one ran.";
        body.textContent = "Nothing was sent for this slide, so nothing was charged.";
      }
      primary.textContent = "Describe this slide";
      primary.hidden = batchRunning;
      primary.addEventListener("click", () => describeSingleJob(job.id, "describe"));
      ocrBtn.hidden = batchRunning;
    } else if (batchRunning) {
      if (runScope === "batch") {
        title.textContent = "Queued.";
        body.textContent = "Waiting for other slides in this batch to finish first.";
      } else {
        title.textContent = "Waiting.";
        body.textContent =
          "Another slide is being described right now — this one can run when it finishes.";
      }
      primary.hidden = true;
    } else {
      title.textContent = "Not described yet.";
      body.textContent = job.resized
        ? `Ready to go — resized to ${job.width}×${job.height} so the request stays small.`
        : "Ready to go.";
      primary.textContent = "Describe this slide";
      primary.addEventListener("click", () => describeSingleJob(job.id, "describe"));
      ocrBtn.hidden = false;
    }
  }

  // renderDetail rebuilds the whole template, so <details> would snap shut on
  // every re-render — including right after saving a source edit, where the
  // panel is exactly what the user is looking at.
  const sourceWasOpen = els.detailPane.querySelector(".js-source")?.open;
  const newSource = frag.querySelector(".js-source");
  if (newSource && sourceWasOpen) newSource.open = true;

  // Same problem for keyboard focus: replaceChildren discards the control
  // the user just activated (Approve & next, Save changes, Retry…), dropping
  // focus to <body> — a keyboard or screen-reader user would have to re-Tab
  // from the top of the page after every single action. Restore focus to the
  // rebuilt pane's equivalent control, or the pane itself as a fallback.
  const active = document.activeElement;
  let focusSel = null;
  if (active && els.detailPane.contains(active)) {
    const jsClass = [...active.classList].find((c) => c.startsWith("js-"));
    // Focus in the editable preview means an edit was just saved — the Edit
    // button (now reading "Edit" again) is the natural continuation; the
    // preview div itself isn't focusable.
    focusSel = jsClass === "js-preview" ? ".js-edit" : jsClass ? `.${jsClass}` : null;
  }

  els.detailPane.replaceChildren(frag);
  els.detailPane.hidden = false;

  if (focusSel) {
    const target = els.detailPane.querySelector(focusSel);
    if (target && !target.hidden && !target.disabled && !target.closest("[hidden]")) {
      target.focus();
    } else {
      els.detail.focus();
    }
  }
}

// ---------- Approve & edit ----------

function toggleApprove(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.state !== "done") return;
  commitPendingEdit(); // approve what's on screen, not the pre-edit version
  job.approved = !job.approved;
  markDirty();
  renderRailRow(job);
  updateControls();
  updateOverallStatus();
  if (job.approved) {
    setStatus(`${job.name} approved.`);
    selectNextUnapproved();
  } else {
    renderDetail();
    setStatus(`${job.name} un-approved.`);
  }
}

/** Reflect whether the current selection is bold/italic on the toggle
    buttons — without this a screen-reader user can't tell the state. */
function updateToolbarPressed() {
  if (editMode !== "preview") return;
  const toolbar = els.detailPane.querySelector(".js-edit-toolbar");
  if (!toolbar || toolbar.hidden) return;
  toolbar
    .querySelector('[data-cmd="bold"]')
    ?.setAttribute("aria-pressed", String(document.queryCommandState("bold")));
  toolbar
    .querySelector('[data-cmd="italic"]')
    ?.setAttribute("aria-pressed", String(document.queryCommandState("italic")));
}
document.addEventListener("selectionchange", updateToolbarPressed);

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
  job.mathWarning = null;
  editMode = null;
  preview.removeAttribute("contenteditable");
  renderDetail();
  updateControls();
  markDirty();
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
  job.mathWarning = null;
  editMode = null;
  textarea.readOnly = true;
  renderDetail();
  updateControls();
  markDirty();
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
  // Any open dialog, not a list of specific ones: showModal() makes the page
  // inert to focus and pointers but does nothing to keydown, which still
  // bubbles from inside the dialog to this listener. A named allow-list means
  // every dialog added later silently inherits the review shortcuts.
  if (document.querySelector("dialog[open]") || !els.onboarding.hidden) return;
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
  // The button is about to disable (and later hide) while focused, which
  // would silently drop keyboard focus to <body>.
  if (document.activeElement === els.stopBtn) els.detail.focus();
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
  runScope = "batch";
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
  runScope = null;
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

  // The refine buttons steer the slide's MODE, not just this one request —
  // job.textOnly is what describeOne falls back to whenever no explicit
  // revision rides along (Retry, Redo with a stronger model). Without this,
  // OCR → "More detail" → "Redo with Opus" snapped back to a bare
  // transcription, undoing the narrative the user had just steered toward.
  // "Text only" is sticky like the OCR button; "More detail" is a request
  // for narrative, so it clears the mode; "Shorter" keeps whatever mode the
  // slide is in — a shorter transcription is still a transcription, so the
  // text-only framing must ride along with it.
  if (revisionKey === "textOnly") job.textOnly = true;
  else if (revisionKey === "more") job.textOnly = false;
  let revision = revisionKey ? REVISIONS[revisionKey] : "";
  if (revisionKey === "less" && job.textOnly) {
    revision = `${REVISIONS.textOnly}\n\n${REVISIONS.less}`;
  }

  batchRunning = true;
  runScope = "single";
  // Stale from a previous batch's Stop — only runBatch resets it, so without
  // this, describeOne would instantly re-cancel instead of running.
  cancelRequested = false;
  renderAll();

  await describeOne(job, {
    apiKey,
    model: overrideModel || job.usedModel || els.model.value,
    verbosity: currentVerbosity(),
    revision,
  });

  batchRunning = false;
  runScope = null;
  if (job.state !== "done") {
    // The revision failed — put the previous (still good) description back
    // instead of hiding it behind an error pane, whose Retry button wouldn't
    // even carry the revision instruction.
    const previous = job.history.pop();
    job.resultHtml = previous.html;
    job.resultText = previous.text;
    setError(
      `Couldn't revise ${job.name}: ${(job.error || "the request didn't finish").replace(/\.$/, "")}. ` +
        `The previous description is untouched.`
    );
    job.state = "done";
    job.error = null;
  } else {
    // A successful revision replaces the description, so it needs review again.
    job.approved = false;
  }
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
  // user already took off the list. A job with no base64 hasn't finished
  // decoding; a request for it would carry an undefined image payload.
  if (!jobs.has(job.id) || !job.base64) return;

  // A slide marked OCR-only stays OCR-only down every path that reaches here
  // — Describe all, Retry, Redo with a stronger model — without each caller
  // having to know about the flag. An explicit revision (the refine buttons)
  // still wins, so "More detail" on an OCR slide does what it says.
  if (!revision && job.textOnly) revision = REVISIONS.textOnly;

  job.state = "describing";
  job.attempt = 1;
  job.requestSent = false;
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
      // From here the request is on the wire — a cancel after this point is
      // an abort of a sent (possibly billable) request, not a skipped one,
      // and the canceled-state copy distinguishes the two.
      job.requestSent = true;
      const requestHeaders = {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      };
      // Anthropic's API refuses direct browser (CORS) calls unless the page
      // opts in with this header; Parley doesn't expect it, so it is only
      // sent where it is required.
      if (keyIsAnthropic(apiKey)) {
        requestHeaders["anthropic-dangerous-direct-browser-access"] = "true";
      }
      const response = await fetch(`${apiBaseFor(apiKey)}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: requestHeaders,
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
                  // The transcript is grounding, not content: it sharpens
                  // terminology (the lecturer said "SSP scenarios", so the
                  // axis label isn't guessed at) without licensing the model
                  // to describe things the slide doesn't show.
                  text: job.transcriptContext
                    ? `${USER_INSTRUCTION_TEXT}\n\nTRANSCRIPT CONTEXT — what the lecturer was saying ` +
                      `around the moment this slide was shown. Use it only to interpret what is visible: ` +
                      `correct spellings and terminology, expand abbreviations, name symbols the way the ` +
                      `course does. Do not add information from it that is not on the slide, do not quote ` +
                      `it, and do not describe it.\n\n${job.transcriptContext}`
                    : USER_INSTRUCTION_TEXT,
                },
              ],
            },
          ],
        }),
      });

      // Read the body before releasing the controller — Stop's abort() must
      // still be able to reach a request whose headers have arrived but
      // whose body is mid-stream, or that request silently completes.
      const { raw, json: payload } = await readResponseBody(response);
      inFlightControllers.delete(controller);
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
      job.error = describeFetchError(err, apiBaseFor(apiKey));
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
    `The API returned HTTP ${response.status} with ${contentType} instead of JSON${redirected}` +
    `${titlePart}. The request likely reached a login page or an error page rather than the API — ` +
    `double-check the API key, and if this keeps happening, ask MIT IT whether this endpoint requires ` +
    `something other than a direct browser request.`
  );
}

function describeFetchError(err, base) {
  const msg = err && err.message ? err.message : String(err);
  if (msg === "Failed to fetch") {
    const host = base || PARLEY_BASE_URL;
    const cors =
      host === ANTHROPIC_BASE_URL
        ? `the Anthropic API not allowing cross-origin (CORS) requests from ${location.origin}`
        : `MIT Parley not allowing cross-origin (CORS) requests from ${location.origin} — if your key ` +
          `works from a terminal but not here, ask MIT IT to enable browser (CORS) access from this origin`;
    return (
      `Could not reach ${host} — the browser blocked or failed the request before getting a ` +
      `response. This is usually either no network connection, or ${cors}.`
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
  const SAFE_HREF_SCHEME_RE = /^(https:|mailto:)/i;
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

  const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

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
      // MathML stays (it's the product), but only genuinely-MathML content.
      // An HTML element smuggled into a math subtree through an HTML
      // integration point (<mtext>, <annotation-xml>…) parses inert here,
      // but this sanitizer's output is serialized to a string and later
      // reparsed in contexts outside a math element (zip export, Copy
      // HTML) — where the element boundaries re-segment and previously
      // inert text can come back as live markup (the namespace-confusion
      // "mXSS" family). No legitimate equation needs HTML inside it.
      if (el.namespaceURI !== MATHML_NS && el.closest("math")) {
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
        // srcset is a URL-carrying attribute src's scheme check never sees;
        // the model has no legitimate image URLs, so drop it outright rather
        // than parse its comma-separated candidate list.
        if (name === "srcset" || name === "imagesrcset") el.removeAttribute(attr.name);
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

// ---------- MathML validation ----------
//
// Malformed equation markup fails ugly: the browser's error recovery
// renders SOMETHING — cascading fractions, operators stacked in a
// staircase — which a sighted reviewer skims past as "math-looking" and a
// screen reader garbles. The rules are strict enough to check mechanically,
// so a broken equation gets flagged the moment it lands instead of sitting
// there looking done.

// Layout elements with a fixed child count in MathML Core.
const MATHML_ARITY = {
  mfrac: 2,
  mover: 2,
  munder: 2,
  msub: 2,
  msup: 2,
  mroot: 2,
  msubsup: 3,
  munderover: 3,
};

/** Structural problems in the (already parsed) description HTML. */
function mathmlProblems(html) {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  const problems = [];
  holder.querySelectorAll("math *").forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const need = MATHML_ARITY[tag];
    if (need !== undefined && el.children.length !== need) {
      problems.push(`<${tag}> with ${el.children.length} part${el.children.length === 1 ? "" : "s"} (needs ${need})`);
    }
  });
  return problems;
}

/**
 * Whether the model's RAW <math> markup was well-formed. The HTML parser
 * silently repairs unclosed and misnested tags by moving content around —
 * producing a structurally "valid" tree that renders scrambled, which the
 * arity check above can no longer see. XML parsing is strict, so running
 * each raw <math> block through it catches exactly that family. Checked
 * against the raw string because the damage is invisible after parsing.
 */
function rawMathIsWellFormed(rawHtml) {
  const blocks = rawHtml.match(/<math[\s\S]*?<\/math>/gi) || [];
  return blocks.every((block) => {
    // Numeric/character entities are fine either way; named HTML entities
    // (&nbsp;) aren't defined in bare XML — neutralize so only STRUCTURE
    // can fail the parse.
    const neutral = block.replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, "?");
    const doc = new DOMParser().parseFromString(neutral, "application/xml");
    return !doc.querySelector("parsererror");
  });
}

function applyResult(job, rawHtml) {
  const fragment = sanitizeHtmlFragment(rawHtml);
  const holder = document.createElement("div");
  holder.appendChild(fragment.cloneNode(true));
  job.resultHtml = holder.innerHTML;
  job.resultText = domFragmentToText(fragment);
  job.mathWarning = rawMathIsWellFormed(rawHtml)
    ? null
    : "The equation markup in this description came back misnested, so it will render scrambled.";
}

// ---------- Capture from video ----------
//
// A second way to get slides in: play a local recording, pause on a slide,
// and hand that frame to the same pipeline an uploaded image goes through.
// The video is read via an object URL and never uploaded or persisted —
// only the frames become jobs.

let videoObjectUrl = null;
let videoStem = "";
let videoCaptureCount = 0;
// Whole seconds already captured from the loaded video. Two grabs in the same
// second are the same frame to the nearest timestamp, and would produce two
// slides with an identical name and an identical "Slide shown at 4:32"
// caption — indistinguishable in the export.
let videoCapturedSeconds = new Set();
let captureInFlight = false;
// { stem, name, cues: [{ start, end, text }] } for the loaded video, or null.
// Session-only, like the video itself — what persists is the per-job excerpt
// attached at capture time.
let videoTranscript = null;

const TRANSCRIPT_WINDOW_SECONDS = 60;
const TRANSCRIPT_EXCERPT_MAX_CHARS = 1800;

/**
 * Parses SRT (and, incidentally, most WebVTT — same timestamp shape, and
 * non-cue blocks like the WEBVTT header simply fail the timecode match and
 * are skipped). Returns [{ start, end, text }] in seconds, sorted. Tolerant
 * by design: a malformed block is dropped, not fatal — a transcript with a
 * few bad cues is still worth having.
 */
function parseSrt(raw) {
  // Hours are optional: WebVTT writes MM:SS.mmm for cues under the hour
  // (ffmpeg's .vtt output does), and requiring them silently dropped every
  // cue in a lecture's first hour while "attaching" the file successfully.
  const TIMECODE =
    /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
  const cues = [];
  for (const block of raw.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timeAt = lines.findIndex((line) => TIMECODE.test(line));
    if (timeAt === -1) continue;
    const m = lines[timeAt].match(TIMECODE);
    const toSeconds = (h, min, s, ms) =>
      Number(h || 0) * 3600 + Number(min) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
    const text = lines
      .slice(timeAt + 1)
      .join(" ")
      // Only things shaped like markup: "</i>", "<font …>", "<v Speaker>".
      // A bare /<[^>]*>/ also matched "< 5, then y >" and gutted exactly the
      // inequality-laden captions a STEM lecture produces.
      .replace(/<\/?[a-zA-Z][^<>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    cues.push({
      start: toSeconds(m[1], m[2], m[3], m[4]),
      end: toSeconds(m[5], m[6], m[7], m[8]),
      text,
    });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/**
 * The transcript within a minute either side of a moment — what the
 * lecturer was saying while this slide was up. Trimmed from the edges when
 * over budget, so what survives is what was said closest to the moment.
 */
function excerptFromCues(cues, seconds) {
  let picked = cues.filter(
    (cue) =>
      cue.end >= seconds - TRANSCRIPT_WINDOW_SECONDS &&
      cue.start <= seconds + TRANSCRIPT_WINDOW_SECONDS
  );
  const total = () => picked.reduce((n, cue) => n + cue.text.length + 1, 0);
  while (picked.length > 1 && total() > TRANSCRIPT_EXCERPT_MAX_CHARS) {
    const first = picked[0];
    const last = picked[picked.length - 1];
    if (seconds - first.end >= last.start - seconds) picked.shift();
    else picked.pop();
  }
  const text = picked.map((cue) => cue.text).join(" ");
  return text ? text.slice(0, TRANSCRIPT_EXCERPT_MAX_CHARS) : null;
}

/** The excerpt against the video dialog's own loaded transcript. */
function transcriptExcerpt(seconds) {
  return videoTranscript ? excerptFromCues(videoTranscript.cues, seconds) : null;
}

// ---------- Transcripts dropped into the workspace ----------
//
// The other way a transcript gets in: dropped or picked alongside uploaded
// images. Pairing is by name — "Lecture_3.srt" belongs to images named
// "Lecture_3_HH-MM-SS.*", the exact convention the video capture writes.
// Session-only like the dialog's transcript; what persists is the per-job
// excerpt (and timestamp) stamped onto matching jobs.

const workspaceTranscripts = new Map(); // normalized stem -> { name, cues }

/**
 * "Lecture_3_00-04-32.jpg" -> { prefix: "Lecture_3", seconds: 272 }, or null
 * for a name without the trailing timestamp. Deliberately strict — exactly
 * HH-MM-SS at the end of the stem — so ordinary filenames with digits don't
 * get read as timestamps.
 */
function timestampFromName(name) {
  const stem = name.replace(/\.[^.]+$/, "");
  // Underscore separator only — it is what the capture writes, and the looser
  // [_\s-] read GNOME's "Screenshot from 2026-08-20 14-30-05.png" as a frame
  // fourteen and a half hours into a video. Minutes and seconds are range-
  // checked for the same reason: a real capture never writes 12-99-99.
  const m = stem.match(/_(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (minutes > 59 || seconds > 59) return null;
  return {
    prefix: stem.slice(0, m.index),
    seconds: Number(m[1]) * 3600 + minutes * 60 + seconds,
  };
}

function isTranscriptFile(file) {
  return /\.(srt|vtt)$/i.test(file.name);
}

/**
 * The stems a transcript file can pair under. Besides the literal stem,
 * subtitle tooling commonly writes a language-tagged name beside the video —
 * "Lecture_3.en.srt", the convention VLC and yt-dlp use — so a trailing
 * language code offers the base name as a second candidate.
 */
function transcriptStemCandidates(fileName) {
  const stem = safeVideoStem(fileName);
  const base = stem.replace(/\.[a-z]{2,3}(?:-[a-z]{2,4})?$/i, "");
  return base && base !== stem ? [stem, base] : [stem];
}

/**
 * Parses and stores a transcript dropped into the workspace, then walks the
 * existing batch attaching context to any job it pairs with — so the order
 * you drop things in doesn't matter, and a batch captured earlier from the
 * video dialog can pick its transcript up after the fact.
 */
async function registerWorkspaceTranscript(file) {
  let cues = [];
  try {
    cues = parseSrt(await file.text());
  } catch (err) {
    cues = [];
  }
  if (cues.length === 0) return `No captions found in "${file.name}" — is it a valid .srt file?`;

  // Registered under every stem it can pair as — "Lecture_3.en.srt" answers
  // for both "Lecture_3.en" and "Lecture_3". The base name is what images
  // are actually named after, so it leads in messages.
  const candidates = transcriptStemCandidates(file.name);
  const entry = { name: file.name, cues };
  for (const c of candidates) workspaceTranscripts.set(c, entry);
  const stems = new Set(candidates);
  const baseStem = candidates[candidates.length - 1];

  let attached = 0;
  for (const job of jobs.values()) {
    if (job.transcriptContext) continue; // already has context; don't clobber
    const seconds = Number.isFinite(job.captureSeconds)
      ? job.captureSeconds
      : (() => {
          const stamp = timestampFromName(job.name);
          return stamp && stems.has(normalizeStem(stamp.prefix)) ? stamp.seconds : null;
        })();
    if (seconds === null) continue;
    // For name-derived matches the stem check happened above; for jobs that
    // already carry a timestamp, pair on their recorded source video.
    if (Number.isFinite(job.captureSeconds) && !stems.has(job.videoName)) continue;
    job.captureSeconds = seconds;
    if (!job.videoName) job.videoName = baseStem;
    job.transcriptContext = excerptFromCues(cues, seconds);
    attached += job.transcriptContext ? 1 : 0;
  }
  if (attached > 0) markDirty();

  return attached > 0
    ? `Transcript "${file.name}" attached to ${attached} slide${attached === 1 ? "" : "s"}.`
    : `Transcript "${file.name}" loaded — it will pair with images named ${baseStem}_HH-MM-SS.`;
}

function setTranscriptHint(message) {
  els.transcriptHint.textContent = message;
}

function clearTranscript() {
  videoTranscript = null;
  els.transcriptInput.value = "";
  // Kept to one short line: this hint shares a row with the video picker,
  // and a wrapping hint grows the dialog's fixed chrome, which the video's
  // height budget in style.css is measured against.
  setTranscriptHint("Optional — named like the video.");
}
// The crop region, as fractions of the video's own width/height (0..1), so
// it stays pinned to the same picture region however the dialog is sized.
// null = no crop; captures take the full frame.
let videoCropRegion = null;
let videoCropDraft = null; // {startX, startY} in fractions, while dragging

/** "4:32", or "1:04:32" once the hour matters. For people to read. */
function formatClock(totalSeconds) {
  // A video with no declared length reports Infinity, which would otherwise
  // render as "Infinity:NaN:NaN".
  if (!Number.isFinite(totalSeconds)) return "0:00";
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** "00-04-32". Always padded, always hyphens — a colon is illegal in a
 *  Windows filename and would break extracting the exported zip. */
function formatStampForName(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}-${pad(Math.floor((s % 3600) / 60))}-${pad(s % 60)}`;
}

/**
 * Normalises the video's filename into a filename-safe stem at capture time,
 * so the name shown in the rail is byte-for-byte the name that ends up in
 * the zip and in the /static/ reference. Characters like "#" are stripped
 * rather than escaped: the zip entry would survive them, but Studio
 * truncates the URL at the fragment and the image silently 404s.
 */
/** The cleaning half alone, for strings that are already extension-less —
 *  an image name's prefix may legitimately contain a dot ("Lecture.v2"),
 *  which extension-stripping would eat. */
function normalizeStem(stem) {
  const cleaned = stem
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]+/g, "")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return cleaned || "video";
}

function safeVideoStem(fileName) {
  return normalizeStem(fileName.replace(/\.[^.]+$/, ""));
}

// The two lines are alternatives, not companions: leaving the last success
// message under a failure reads as a contradiction ("Captured the frame at
// 0:00" directly beneath "You already captured the frame at 0:00"), and the
// pair together take enough height to push the whole lot out of a short
// window. Whichever fires last is the one that is true.
function setVideoError(message) {
  els.videoError.textContent = message;
  els.videoError.hidden = !message;
  if (message) els.videoStatus.textContent = "";
}

function setVideoStatus(message) {
  els.videoStatus.textContent = message;
  if (message) {
    els.videoError.textContent = "";
    els.videoError.hidden = true;
  }
}

function updateVideoTime() {
  const video = els.videoEl;
  els.videoTimeLabel.textContent = formatClock(video.currentTime);
  if (Number.isFinite(video.duration)) els.videoScrub.value = String(video.currentTime);
}

/**
 * These icons are <svg>, and `hidden` is an HTMLElement property that
 * SVGElement does not reflect — assigning el.hidden on one sets a plain JS
 * property, leaves the attribute alone, and changes nothing on screen.
 * toggleAttribute works on any element, which is what the [hidden] rule in
 * the UA stylesheet actually keys off.
 */
function showIcon(el, visible) {
  el.toggleAttribute("hidden", !visible);
}

function updatePlayPauseIcon() {
  const playing = !els.videoEl.paused && !els.videoEl.ended;
  showIcon(els.videoPlayIcon, !playing);
  showIcon(els.videoPauseIcon, playing);
  els.videoPlayPause.setAttribute("aria-label", playing ? "Pause" : "Play");
}

/** Silent covers both routes to it — the mute toggle and a volume dragged
 *  to zero — so the icon never claims sound is playing when it is not. */
function updateVolumeUi() {
  const silent = els.videoEl.muted || els.videoEl.volume === 0;
  showIcon(els.videoSoundOnIcon, !silent);
  showIcon(els.videoSoundOffIcon, silent);
  els.videoMute.setAttribute("aria-label", silent ? "Unmute" : "Mute");
  els.videoMute.setAttribute("aria-pressed", silent ? "true" : "false");
}

function releaseVideo() {
  const video = els.videoEl;
  video.pause();
  video.removeAttribute("src");
  // Without the reload the element keeps decoding and holds the file handle
  // open even after the src is gone.
  video.load();
  if (videoObjectUrl) {
    URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl = null;
  }
}

function loadVideoFile(file) {
  setVideoError("");
  releaseVideo();
  videoStem = safeVideoStem(file.name);
  videoCaptureCount = 0;
  videoCapturedSeconds = new Set();
  // A different recording almost certainly has a different layout, so a
  // remembered region would silently crop the wrong part of it.
  setCropMode(false);
  els.videoFileName.textContent = file.name;
  els.videoInputLabel.textContent = "Change video";
  els.transcriptBtn.hidden = false;
  els.transcriptHint.hidden = false;
  // A transcript belongs to one recording; keep it only if its name still
  // matches the video that just loaded.
  if (videoTranscript && videoTranscript.stem !== videoStem) clearTranscript();

  videoObjectUrl = URL.createObjectURL(file);
  els.videoEl.src = videoObjectUrl;
  els.videoStage.hidden = false;
  setVideoStatus("Loading video…");
}

/**
 * Resolves once the video is actually showing the frame for its current
 * position. Without this, capturing straight after a scrub reads the pixels
 * of the frame still on screen while currentTime already reports the new
 * position — a correctly-named file containing the wrong slide, which is
 * far worse than an obvious failure. Falls through after a moment rather
 * than hanging if the events never arrive.
 */
function whenFrameReady(video) {
  const isReady = () => !video.seeking && video.readyState >= 2; // HAVE_CURRENT_DATA
  if (isReady()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", finish);
      video.removeEventListener("loadeddata", finish);
      clearTimeout(timer);
      // Reports whether the frame really did settle. Resolving true on the
      // timeout would hand back exactly the mislabelled capture this exists
      // to prevent, so a slow seek is refused rather than guessed at.
      resolve(isReady());
    };
    const timer = setTimeout(finish, 2000);
    video.addEventListener("seeked", finish);
    video.addEventListener("loadeddata", finish);
  });
}

// ----- Crop: capture a region of the frame instead of all of it -----
//
// For recordings where the slide shares the frame with a webcam strip, a
// player border, or pillarboxing. The region is set once by dragging on the
// paused (or playing) video and then applies to every capture until cleared,
// since the slide area of a lecture recording stays put for the whole video.

function setCropRegion(region) {
  videoCropRegion = region;
  if (region) {
    els.videoCropRect.style.left = `${region.x * 100}%`;
    els.videoCropRect.style.top = `${region.y * 100}%`;
    els.videoCropRect.style.width = `${region.w * 100}%`;
    els.videoCropRect.style.height = `${region.h * 100}%`;
  }
  els.videoCropRect.hidden = !region;
}

function cropModeOn() {
  return els.videoCropBtn.getAttribute("aria-pressed") === "true";
}

function setCropMode(on) {
  els.videoCropBtn.setAttribute("aria-pressed", on ? "true" : "false");
  els.videoCropOverlay.hidden = !on;
  if (!on) {
    setCropRegion(null);
    videoCropDraft = null;
  }
}

/** Pointer position as fractions of the video box, clamped to it. */
function cropPointFromEvent(e) {
  const rect = els.videoCropOverlay.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
  };
}

function cropRegionFromDraft(point) {
  const x = Math.min(videoCropDraft.startX, point.x);
  const y = Math.min(videoCropDraft.startY, point.y);
  return {
    x,
    y,
    w: Math.abs(point.x - videoCropDraft.startX),
    h: Math.abs(point.y - videoCropDraft.startY),
  };
}

/**
 * Draws the frame currently on screen into a canvas and hands it to addFiles
 * as an ordinary File, so nothing downstream needs to know it came from a
 * video. Honors the crop region when one is set. Capped at MAX_IMAGE_EDGE
 * rather than the video's native size — see CAPTURE_JPEG_QUALITY for why
 * that one choice halves what autosave writes.
 */
function captureCurrentFrame() {
  const video = els.videoEl;
  // readyState too, not just the dimensions: those are set at HAVE_METADATA,
  // before there are any pixels to draw.
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
    setVideoError("The video has not loaded a frame yet.");
    return null;
  }

  // Source rectangle: the crop region mapped onto the video's real pixels,
  // or the whole frame. Rounded once, here, so the canvas and drawImage
  // agree exactly.
  const region = videoCropRegion || { x: 0, y: 0, w: 1, h: 1 };
  const sx = Math.round(region.x * video.videoWidth);
  const sy = Math.round(region.y * video.videoHeight);
  const sw = Math.max(1, Math.round(region.w * video.videoWidth));
  const sh = Math.max(1, Math.round(region.h * video.videoHeight));

  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, width, height);

  return {
    dataUrl: canvas.toDataURL("image/jpeg", CAPTURE_JPEG_QUALITY),
    seconds: Math.floor(video.currentTime),
    cropped: !!videoCropRegion,
  };
}

function dataUrlToFile(dataUrl, name, type) {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return new File([base64ToBytes(base64)], name, { type });
}

/** runMode: null = just capture; "describe" or "ocr" = capture and start
 *  that run immediately (the same modes describeSingleJob takes). */
async function captureFrame(runMode) {
  // Both awaits below yield to the event loop, so without this a quick
  // double-click runs two captures concurrently — each passing the
  // already-captured check before the other records its second.
  if (captureInFlight) return;
  captureInFlight = true;
  try {
    await runCapture(runMode);
  } finally {
    captureInFlight = false;
  }
}

/** The slide already captured from this video at this second, if any. Only
 *  dialog captures carry cropKey, so an image UPLOADED under the same stem and
 *  timestamp is never mistaken for one — it holds different pixels. */
function jobAtCapture(seconds) {
  return jobList().find(
    (job) =>
      job.videoName === videoStem &&
      job.captureSeconds === seconds &&
      typeof job.cropKey === "string"
  );
}

/** Identifies the pixels a capture would produce, beyond its timestamp: the
 *  same moment cropped differently is a different picture. Rounded, because a
 *  region is stored as floats and re-deriving it can differ in the last bit. */
function cropKeyOf(region) {
  if (!region) return "full";
  const n = (v) => Math.round(v * 1000);
  return `${n(region.x)},${n(region.y)},${n(region.w)},${n(region.h)}`;
}

async function runCapture(runMode) {
  setVideoError("");
  if (jobs.size >= MAX_BATCH_SIZE) {
    setVideoError(`This batch is full at ${MAX_BATCH_SIZE} slides — export or start a new batch.`);
    return;
  }

  // Ask for the key BEFORE spending the capture. Capturing first and failing
  // afterwards left the frame in the batch and the second recorded, so the
  // obvious retry — clicking the same button again once the key was in —
  // answered "you already captured the frame at 3:25" and did nothing.
  // describeSingleJob reports this on the page's error line, which showModal()
  // has made inert, so say it in here too.
  if (runMode && !els.apiKey.value.trim()) {
    setVideoError(NO_KEY_ERROR);
    openSettings();
    return;
  }

  // Settle any in-flight seek first, so the pixels and the timestamp that
  // names them describe the same moment.
  const ready = await whenFrameReady(els.videoEl);
  if (!ready) {
    setVideoError("The video is still seeking — give it a moment and capture again.");
    return;
  }

  const frame = captureCurrentFrame();
  if (!frame) return;

  if (videoCapturedSeconds.has(frame.seconds)) {
    const clock = formatClock(frame.seconds);
    const existing = jobAtCapture(frame.seconds);

    // "Capture & describe" on a second that is already captured used to
    // dead-end here. That is precisely the state a failed describe leaves
    // behind — the frame is in the batch, the description is not — so the
    // button that would fix it refused to. When only the description is
    // missing, run the slide that is already there.
    if (runMode && existing) {
      // Reuse is only honest when the slide already there holds the pixels the
      // user is asking about. Set up a crop and ask for a description of a
      // second captured full-frame and this would have described the whole
      // board while reporting success — the crop silently ignored.
      if (existing.cropKey !== cropKeyOf(videoCropRegion)) {
        setVideoError(
          `The frame at ${clock} is already captured, but with a different crop. ` +
            `Match the crop it was taken with, or capture a different moment.`
        );
      } else if (existing.state === "done") {
        setVideoError(`The frame at ${clock} is already captured and described — it's in the rail.`);
      } else if (batchRunning || existing.state === "describing") {
        setVideoError(`The frame at ${clock} is already captured and a description is running.`);
      } else if (!existing.base64) {
        setVideoError(`The frame at ${clock} is captured but still decoding — try again in a moment.`);
      } else {
        selectJob(existing.id);
        setVideoStatus(`Already captured ${clock} — describing that slide now.`);
        describeSingleJob(existing.id, runMode);
      }
      return;
    }

    setVideoError(`You already captured the frame at ${clock}.`);
    return;
  }

  const name = `${videoStem}_${formatStampForName(frame.seconds)}.jpg`;
  const file = dataUrlToFile(frame.dataUrl, name, "image/jpeg");

  // Name the batch after the video before the first frame lands. Left alone,
  // maybeNameBatch() takes the longest common prefix of the filenames, and
  // timestamped names share most of their stamp — three captures collapse to
  // something like "My_Lecture_3_00-0". Only when the batch is otherwise
  // empty, so a video never renames a batch of uploaded slides.
  if (jobs.size === 0 && els.batchName.dataset.userNamed !== "1") {
    els.batchName.value = videoStem;
    els.batchName.dataset.userNamed = "1";
  }

  const before = new Set(jobs.keys());
  await addFiles([file], {
    videoName: videoStem,
    captureSeconds: frame.seconds,
    // Session-only, and deliberately not in the project whitelist: it exists
    // to decide whether an already-captured second can be reused, and
    // videoCapturedSeconds — the gate on that path — is empty after a reload
    // anyway.
    cropKey: cropKeyOf(videoCropRegion),
    // Snapshotted per capture, not referenced from the (session-only)
    // transcript, so the context survives save/reload with the job.
    transcriptContext: transcriptExcerpt(frame.seconds),
  });
  const added = jobList().find((job) => !before.has(job.id));

  // addFiles reports refusals on the page's error line, which showModal() has
  // made inert — mirror it in here, and do not claim a capture that did not
  // happen. Recording the second regardless would also lock the user out of
  // ever retrying that moment.
  const pageError = els.errorMessage.hidden ? "" : els.errorMessage.textContent;
  if (!added) {
    setVideoError(pageError || "That frame could not be added to the batch.");
    return;
  }

  videoCapturedSeconds.add(frame.seconds);
  videoCaptureCount += 1;

  if (added.state === "invalid") {
    setVideoError(added.error || "That frame could not be decoded.");
    return;
  }
  if (pageError) setVideoError(pageError);
  else
    // The generated filename used to end this line — around fifty characters
    // of it, under every capture. It is on the slide's rail row and in the
    // export already, so the line just confirms the moment, and picks up the
    // running count that used to sit in the capture bar.
    setVideoStatus(
      `Captured ${formatClock(frame.seconds)}${frame.cropped ? " (cropped)" : ""} — ` +
        `added to the batch. ${videoCaptureCount} frame${videoCaptureCount === 1 ? "" : "s"} so far.`
    );

  if (!runMode) return;
  // A job holds its batch slot before its image data is ready; describing it
  // that early would skip it silently. addFiles has already awaited the
  // decode by this point, so base64 is the check that it actually succeeded.
  // describeSingleJob (not describeOne) because it owns the API-key lookup,
  // the cancel flag and the re-render that a bare describeOne would skip.
  // The mode rides through it, so "ocr" marks the slide text-only exactly
  // as the workspace OCR button does.
  if (added.base64 && !batchRunning) describeSingleJob(added.id, runMode);
}

function openVideoDialog() {
  // renderDetail() bails out entirely while an edit is open, so a capture
  // made with one in progress would land in the rail but never appear in the
  // detail pane. Settle the edit on the way in.
  commitPendingEdit();
  setVideoError("");
  setVideoStatus("");
  els.videoDialog.showModal();
}

els.videoBtn.addEventListener("click", openVideoDialog);
els.videoBtnEmpty.addEventListener("click", openVideoDialog);
els.videoClose.addEventListener("click", () => els.videoDialog.close());

// Fires for the close button and for Escape alike, so the object URL and the
// decoder are released down every path out of the dialog.
els.videoDialog.addEventListener("close", () => {
  releaseVideo();
  setCropMode(false);
  els.videoStage.hidden = true;
  els.videoFileName.textContent = "No video chosen yet.";
  els.videoInputLabel.textContent = "Choose a video";
  els.videoInput.value = "";
  els.transcriptBtn.hidden = true;
  els.transcriptHint.hidden = true;
  clearTranscript();
});

// A capture that needed a key left its reason on this dialog's error line and
// opened settings on top. Once the key is actually in, the warning has
// outlived the problem — clear it rather than leaving it there to contradict
// the next successful capture.
els.settingsDialog.addEventListener("close", () => {
  if (
    els.videoDialog.open &&
    els.apiKey.value.trim() &&
    els.videoError.textContent === NO_KEY_ERROR
  ) {
    setVideoError("");
  }
});

els.videoInput.addEventListener("change", () => {
  const file = els.videoInput.files && els.videoInput.files[0];
  if (file) loadVideoFile(file);
});

els.transcriptInput.addEventListener("change", async () => {
  const file = els.transcriptInput.files && els.transcriptInput.files[0];
  if (!file) return;
  setVideoError("");

  // Matching names is the pairing rule: it is what says this transcript
  // belongs to this recording, and it catches grabbing last week's captions
  // by mistake. Compared through the same normalisation as the video stem so
  // "My Lecture #3.srt" matches "My Lecture #3.mp4"; a language-tagged name
  // like "My Lecture #3.en.srt" counts as a match too.
  const stem = safeVideoStem(file.name);
  if (!transcriptStemCandidates(file.name).includes(videoStem)) {
    els.transcriptInput.value = "";
    setVideoError(
      `That transcript is named "${file.name}", which doesn't match this video — expected "${videoStem}" with a .srt extension.`
    );
    return;
  }

  let cues = [];
  try {
    cues = parseSrt(await file.text());
  } catch (err) {
    cues = [];
  }
  if (cues.length === 0) {
    els.transcriptInput.value = "";
    setVideoError(`No captions found in "${file.name}" — is it a valid .srt file?`);
    return;
  }

  videoTranscript = { stem, name: file.name, cues };
  const last = cues[cues.length - 1];
  setTranscriptHint(
    `${file.name} — ${cues.length} caption${cues.length === 1 ? "" : "s"} through ${formatClock(last.end)}.`
  );
  setVideoStatus(
    "Transcript attached — captures from here on carry the nearby speech as context."
  );
});

/**
 * A recording whose header carries no length — anything from MediaRecorder,
 * a fragmented MP4 — reports duration as Infinity, sometimes only until the
 * browser works it out and fires durationchange. "Infinity" is not a valid
 * value for the range's max (it silently falls back to 100, leaving all but
 * the first minute and a half unreachable), so the scrubber stands down
 * until there is a real length to scrub against.
 */
function syncVideoDuration() {
  const known = Number.isFinite(els.videoEl.duration) && els.videoEl.duration > 0;
  els.videoScrub.max = String(known ? els.videoEl.duration : 0);
  els.videoScrub.disabled = !known;
  return known;
}

els.videoEl.addEventListener("loadedmetadata", () => {
  const known = syncVideoDuration();
  // Loading a source resets playbackRate to 1, so the chosen speed has to be
  // reapplied or it silently reverts on the next video. Volume and muted are
  // properties of the element and do survive, but are set here too so the
  // controls and the media agree from the first frame.
  els.videoEl.playbackRate = Number(els.videoRate.value) || 1;
  els.videoEl.volume = Number(els.videoVolume.value);
  updateVideoTime();
  updateVolumeUi();
  setVideoStatus(
    known
      ? `Loaded — ${formatClock(els.videoEl.duration)} long. Pause on a slide, then capture.`
      : "Loaded. This file does not report its length, so use play and the skip buttons to move through it."
  );
});
els.videoEl.addEventListener("durationchange", syncVideoDuration);
els.videoEl.addEventListener("error", () => {
  els.videoStage.hidden = true;
  setVideoError("That video could not be played. Try an MP4 (H.264) or WebM file.");
});
els.videoEl.addEventListener("timeupdate", updateVideoTime);
els.videoEl.addEventListener("seeked", updateVideoTime);
els.videoEl.addEventListener("play", updatePlayPauseIcon);
els.videoEl.addEventListener("pause", updatePlayPauseIcon);

els.videoPlayPause.addEventListener("click", () => {
  if (els.videoEl.paused) els.videoEl.play();
  else els.videoEl.pause();
});
els.videoBack.addEventListener("click", () => {
  els.videoEl.currentTime = Math.max(0, els.videoEl.currentTime - VIDEO_SKIP_SECONDS);
});
els.videoFwd.addEventListener("click", () => {
  const end = Number.isFinite(els.videoEl.duration) ? els.videoEl.duration : Infinity;
  els.videoEl.currentTime = Math.min(end, els.videoEl.currentTime + VIDEO_SKIP_SECONDS);
});
els.videoScrub.addEventListener("input", () => {
  els.videoEl.currentTime = Number(els.videoScrub.value);
});

els.videoRate.addEventListener("change", () => {
  els.videoEl.playbackRate = Number(els.videoRate.value) || 1;
});

els.videoMute.addEventListener("click", () => {
  // A silent/audible toggle, not a muted-flag toggle. Those differ once the
  // slider is at zero: the flag is still false, so flipping it would mute an
  // already-silent video, leaving the button labelled "Unmute" both before
  // and after and needing a second press to produce any sound.
  const silent = els.videoEl.muted || els.videoEl.volume === 0;
  if (!silent) {
    els.videoEl.muted = true;
    return;
  }
  if (els.videoEl.volume === 0) {
    els.videoEl.volume = 1;
    els.videoVolume.value = "1";
  }
  els.videoEl.muted = false;
});

els.videoVolume.addEventListener("input", () => {
  els.videoEl.volume = Number(els.videoVolume.value);
  // Dragging up from silence is an unmute in everything but name.
  if (els.videoEl.volume > 0 && els.videoEl.muted) els.videoEl.muted = false;
});

// Covers changes made anywhere — the buttons above, or the media element
// itself — so the icon can never drift out of step with what you hear.
els.videoEl.addEventListener("volumechange", updateVolumeUi);

els.videoCapture.addEventListener("click", () => captureFrame(null));
els.videoCaptureDescribe.addEventListener("click", () => captureFrame("describe"));
els.videoCaptureOcr.addEventListener("click", () => captureFrame("ocr"));

// ----- Crop wiring -----

els.videoCropBtn.addEventListener("click", () => {
  const on = !cropModeOn();
  setCropMode(on);
  setVideoStatus(
    on
      ? "Crop is on — drag across the video to pick the region to capture. Drag again to redraw; press Crop again to clear."
      : "Crop cleared — captures take the full frame again."
  );
});

els.videoCropOverlay.addEventListener("pointerdown", (e) => {
  if (!cropModeOn() || !e.isPrimary) return;
  const point = cropPointFromEvent(e);
  if (!point) return;
  els.videoCropOverlay.setPointerCapture(e.pointerId);
  videoCropDraft = { startX: point.x, startY: point.y, before: videoCropRegion };
  setCropRegion({ x: point.x, y: point.y, w: 0, h: 0 });
  e.preventDefault();
});

els.videoCropOverlay.addEventListener("pointermove", (e) => {
  if (!videoCropDraft) return;
  const point = cropPointFromEvent(e);
  if (point) setCropRegion(cropRegionFromDraft(point));
});

els.videoCropOverlay.addEventListener("pointerup", (e) => {
  if (!videoCropDraft) return;
  const point = cropPointFromEvent(e);
  const region = point ? cropRegionFromDraft(point) : null;
  videoCropDraft = null;
  // A sub-2% drag is a click or a slip, not a selection — a region that
  // tiny would capture a handful of source pixels and describe nothing.
  if (!region || region.w < 0.02 || region.h < 0.02) {
    setCropRegion(null);
    setVideoStatus("Crop selection was too small — drag across the video to pick a larger region.");
    return;
  }
  setCropRegion(region);
  const video = els.videoEl;
  const pw = Math.round(region.w * video.videoWidth);
  const ph = Math.round(region.h * video.videoHeight);
  setVideoStatus(`Cropping captures to a ${pw}×${ph} region. Drag again to redraw; press Crop again to clear.`);
});

els.videoCropOverlay.addEventListener("pointercancel", () => {
  if (!videoCropDraft) return;
  // Back to the region from before the drag started — NOT the current one,
  // which pointermove has been overwriting with the half-drawn draft. A
  // cancelled drag must not leave an unvalidated sliver (possibly 0×0)
  // active, silently cropping every capture after it to a few pixels.
  const before = videoCropDraft.before;
  videoCropDraft = null;
  setCropRegion(before);
});

// Inside the dialog Escape means "back out of crop mode" before it means
// "close the dialog" — cancel fires on Escape for a modal dialog, and
// preventing it keeps the dialog open for that press.
els.videoDialog.addEventListener("cancel", (e) => {
  if (cropModeOn()) {
    e.preventDefault();
    setCropMode(false);
    setVideoStatus("Crop cleared — captures take the full frame again.");
  }
});

// Space would otherwise activate whichever button has focus, and the arrows
// are handled here so they scrub instead of stepping the range widget by its
// tiny 0.01 step. The global review shortcuts already stand down for any open
// dialog, so this only has to cover the dialog's own controls.
els.videoDialog.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (typingInFormField(e.target) && e.target !== els.videoScrub) return;
  if (els.videoStage.hidden) return;

  if (e.key === " " || e.key === "Spacebar") {
    e.preventDefault();
    if (els.videoEl.paused) els.videoEl.play();
    else els.videoEl.pause();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    els.videoEl.currentTime = Math.max(0, els.videoEl.currentTime - VIDEO_SKIP_SECONDS);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    const end = Number.isFinite(els.videoEl.duration) ? els.videoEl.duration : Infinity;
    els.videoEl.currentTime = Math.min(end, els.videoEl.currentTime + VIDEO_SKIP_SECONDS);
  }
});

// ---------- Copy buttons ----------

async function copyToClipboard(text, button, label) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${label} to clipboard.`);
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
// for — and there's no need for one. These are small HTML text files (plus
// the source slide images); storing them uncompressed keeps the writer to a
// CRC table and three record layouts.

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

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
    const data = file.bytes || encoder.encode(file.content);
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

// Every approved slide in the batch becomes one <img> + description block in
// a single HTML fragment, in rail order — meant to be pasted whole into one
// Studio HTML component below the video(s) it describes. The <img> points at
// /static/<filename>, matching how Studio serves a file uploaded through
// Files & Uploads; alt is left empty because the description text
// immediately follows it on the page, so a screen reader isn't given the
// same content twice. A slide captured from a video gets a <figure> wrapper
// carrying its timestamp instead — see exportBlockFor.
function uniqueName(name, taken) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${stem}-${n}${ext}`;
    n += 1;
  }
  taken.add(candidate);
  return candidate;
}

function renameExtension(name, ext) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${ext}`;
}

/** ISO 8601 duration ("PT4M32S") — the only form <time datetime> accepts for
 *  an offset into a recording. */
function isoDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  return `PT${Math.floor(s / 3600)}H${Math.floor((s % 3600) / 60)}M${s % 60}S`;
}

/**
 * One slide's block in the exported fragment, shaped as:
 *
 *   <h2 tabindex="0">title</h2>       (tabindex so the slide sections are
 *   <p>opening summary</p>            keyboard-reachable in Studio)
 *   <figure> img + timestamp </figure>  — or a bare <img> for uploads
 *   ...rest of the description...
 *
 * The image sits after the title and opening sentence rather than in front
 * of everything, so a listener hears what the slide is before meeting it.
 * The <figure>/<figcaption> pair is reserved for the slide image and its
 * timestamp: any figure the model wrote inside a description is unwrapped
 * (its caption becoming a <p>) — the prompt now forbids them, but slides
 * described before that change still carry some.
 *
 * The caption is derived from job.captureSeconds rather than parsed back out
 * of the filename: the name is user-editable and gets rewritten on the way
 * out (spaces, extension, de-duplication suffix), so it is not a reliable
 * carrier. The DOM work here operates on already-sanitized resultHtml and
 * our own image markup — nothing untrusted. Running the result through the
 * app's own sanitizer instead would strip the /static/ src and then drop
 * the <img> entirely.
 */
function exportBlockFor({ job, imageName }) {
  const container = document.createElement("div");
  container.innerHTML = job.resultHtml;

  container.querySelectorAll("h2").forEach((h) => h.setAttribute("tabindex", "0"));

  container.querySelectorAll("figcaption").forEach((caption) => {
    const p = document.createElement("p");
    while (caption.firstChild) p.appendChild(caption.firstChild);
    caption.replaceWith(p);
  });
  container.querySelectorAll("figure").forEach((figure) => {
    while (figure.firstChild) figure.parentNode.insertBefore(figure.firstChild, figure);
    figure.remove();
  });

  const holder = document.createElement("div");
  // Number.isFinite, not truthiness: a frame captured at 0:00 is legitimate
  // and its timestamp is 0.
  holder.innerHTML = Number.isFinite(job.captureSeconds)
    ? `<figure>\n<img src="/static/${escapeHtml(imageName)}" alt="">\n` +
      `<figcaption>Slide in video at <time datetime="${isoDuration(job.captureSeconds)}">${formatClock(job.captureSeconds)}</time></figcaption>\n</figure>`
    : `<img src="/static/${escapeHtml(imageName)}" alt="">`;

  // Placement anchor: a leading heading, then the summary paragraph right
  // after it. A description that opens some other way gets the image first,
  // as before.
  let anchor = null;
  const children = [...container.children];
  let i = 0;
  if (children[i] && /^H[1-4]$/.test(children[i].tagName)) anchor = children[i++];
  if (children[i] && children[i].tagName === "P") anchor = children[i];

  const imageNodes = [document.createTextNode("\n"), ...holder.childNodes, document.createTextNode("\n")];
  if (anchor) imageNodes.reverse().forEach((node) => anchor.after(node));
  else imageNodes.reverse().forEach((node) => container.prepend(node));

  return container.innerHTML;
}

// Downscales to EXPORT_RESIZE_WIDTH only when the image is wider than that
// (never upscales); returns the original bytes untouched otherwise. Runs
// against the true original bytes, not whatever was resized for the API.
// PNGs stay PNG — lossless, no compression artifacts on the text and line
// art typical of slides; other formats re-encode as high-quality JPEG.
async function resizeImageForExport(base64, mediaType) {
  const img = await loadImageElement(`data:${mediaType};base64,${base64}`);
  if (img.naturalWidth <= EXPORT_RESIZE_WIDTH) {
    return { bytes: base64ToBytes(base64), ext: null };
  }

  const scale = EXPORT_RESIZE_WIDTH / img.naturalWidth;
  const targetW = EXPORT_RESIZE_WIDTH;
  const targetH = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  const keepPng = mediaType === "image/png";
  if (!keepPng) {
    // JPEG has no alpha channel; flatten onto white first.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, targetW, targetH);
  }
  ctx.drawImage(img, 0, 0, targetW, targetH);

  const resizedDataUrl = keepPng
    ? canvas.toDataURL("image/png")
    : canvas.toDataURL("image/jpeg", EXPORT_JPEG_QUALITY);
  const resizedBase64 = resizedDataUrl.slice(resizedDataUrl.indexOf(",") + 1);
  return { bytes: base64ToBytes(resizedBase64), ext: keepPng ? null : "jpg" };
}

async function exportApproved() {
  // What's exported must be what's on screen — including an edit that
  // hasn't been explicitly saved yet.
  commitPendingEdit();
  const approved = jobList().filter((j) => j.state === "done" && j.approved);
  if (approved.length === 0) return;

  const batch = els.batchName.value.trim() || "Untitled batch";
  const shouldResize = els.exportResize.checked;

  const prepared = [];
  for (const job of approved) {
    const base64 = job.originalBase64 || job.base64;
    const mediaType = job.originalMediaType || job.mediaType;
    // Spaces in a filename survive a zip fine but are a common source of
    // broken /static/ links once pasted into Studio, so strip them here.
    const name = job.name.replace(/ /g, "_");
    if (!shouldResize) {
      prepared.push({ job, name, bytes: base64ToBytes(base64) });
      continue;
    }
    try {
      const { bytes, ext } = await resizeImageForExport(base64, mediaType);
      prepared.push({ job, name: ext ? renameExtension(name, ext) : name, bytes });
    } catch (err) {
      // A slide that resized fine for upload should always resize fine here
      // too — but if decoding somehow fails, exporting the original is
      // better than dropping the image from the zip entirely.
      prepared.push({ job, name, bytes: base64ToBytes(base64) });
    }
  }

  const imageNames = new Set();
  const entries = prepared.map((p) => ({ ...p, imageName: uniqueName(p.name, imageNames) }));

  // The batch name opens the document as its <h1>: the fragment lands in a
  // Studio HTML component where slide sections start at <h2>, so the page
  // keeps a proper heading outline for screen-reader navigation.
  const html =
    `<h1>${escapeHtml(batch)}</h1>\n\n` + entries.map(exportBlockFor).join("\n\n") + "\n";

  const files = [{ name: "description.html", content: html }];
  for (const { imageName, bytes } of entries) {
    files.push({ name: `static/${imageName}`, bytes });
  }

  const blob = buildZipBlob(files);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFileStem(batch, new Set())}-descriptions.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  setStatus(
    `Exported ${approved.length} approved description${approved.length === 1 ? "" : "s"} — ` +
      (shouldResize ? "images resized to 800px wide." : "images at full resolution.")
  );
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

// ---------- Cameo ----------
// Five quick clicks on the header wordmark plays a short animation. Named
// blandly on purpose — finding it is the whole point. The container is
// aria-hidden with pointer-events: none, so it can never intercept a click,
// a tab stop, or a screen reader.
(() => {
  const cameo = document.getElementById("cameo");
  const brand = document.querySelector(".app-header .brand");
  if (!cameo || !brand) return;
  let clicks = 0;
  let lastClick = 0;
  brand.addEventListener("click", () => {
    const now = Date.now();
    clicks = now - lastClick < 1200 ? clicks + 1 : 1;
    lastClick = now;
    if (clicks < 5 || !cameo.hidden) return;
    clicks = 0;
    cameo.hidden = false;
    cameo.classList.add("is-up");
    cameo.addEventListener(
      "animationend",
      () => {
        cameo.classList.remove("is-up");
        cameo.hidden = true;
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
      let result;
      req.onsuccess = () => {
        result = req.result;
      };
      req.onerror = () => reject(req.error || new Error("Project storage failed."));
      // Resolve on transaction commit, not request success: quota errors on
      // a put commonly surface at commit time, AFTER the request-level
      // success event — resolving early would announce "saved" for a write
      // that was then rolled back.
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error("Project storage was rolled back."));
      tx.onerror = () => reject(tx.error || new Error("Project storage failed."));
    });
  } finally {
    db.close();
  }
}

// ---------- Autosave: the current batch survives a reload ----------
// A shadow record in the same projects store, written debounced after every
// mutation and restored on load. Named projects stay explicit; this only
// protects against the accidental refresh that used to cost a whole
// review session.

const AUTOSAVE_ID = "__autosave";
const AUTOSAVE_DEBOUNCE_MS = 1500;
let autosaveTimer = null;
let autosaveDirty = false;
// Writes are gated until the load-time restore attempt settles: init's
// first renderAll marks dirty with an EMPTY batch, and if the restore's
// read were slower than the debounce, that empty write would destroy the
// very record it was about to restore.
let autosaveReady = false;

function markDirty() {
  autosaveDirty = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(writeAutosave, AUTOSAVE_DEBOUNCE_MS);
}

async function writeAutosave() {
  clearTimeout(autosaveTimer);
  if (!autosaveReady || !autosaveDirty) return;
  // Mid-batch state is churn — the batch's final renderAll re-marks dirty,
  // so the settled result is what gets written.
  if (batchRunning) return;
  autosaveDirty = false;
  const record = {
    ...serializeProject(),
    id: AUTOSAVE_ID,
    // Which named project (if any) the batch was opened from / saved as,
    // so the association survives the reload too.
    projectId: currentProjectId,
    userNamed: els.batchName.dataset.userNamed === "1",
  };
  try {
    await projectStoreRequest("readwrite", (store) => store.put(record));
  } catch (_err) {
    // Best-effort by design: never interrupt real work over a failed
    // background save. An empty-jobs record doubles as "nothing to restore".
  }
}

// Flush on tab hide/close so the last action before closing is kept.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") writeAutosave();
});
window.addEventListener("pagehide", () => writeAutosave());

async function restoreAutosave() {
  try {
    let record;
    try {
      record = await projectStoreRequest("readonly", (store) => store.get(AUTOSAVE_ID));
    } catch (_err) {
      return; // no storage, no restore — same as before autosave existed
    }
    if (!record || !Array.isArray(record.jobs) || record.jobs.length === 0) return;
    if (jobs.size > 0) return; // the user already started something this load
    loadProjectRecord(record);
    // loadProjectRecord treats the record as a named project — undo the two
    // assumptions that don't hold for the shadow record.
    currentProjectId = record.projectId || null;
    // The linked project may have been deleted after this autosave was
    // written — a dangling id would make "Save current batch" silently
    // resurrect the deleted project.
    if (currentProjectId) {
      const exists = await projectStoreRequest("readonly", (store) =>
        store.get(currentProjectId)
      ).catch(() => null);
      if (!exists) currentProjectId = null;
    }
    if (record.userNamed !== true) delete els.batchName.dataset.userNamed;
    setStatus("Restored your last session — everything is as you left it.");
  } finally {
    autosaveReady = true;
  }
}

/** Confirmations that fire while the projects dialog is open must land in
    an in-dialog live region — showModal() makes the page's main status line
    inert (unannounced) and the backdrop hides it visually. The page-level
    status is still set so the state is there after the dialog closes. */
function announceProjects(message) {
  els.projectsStatus.textContent = message;
  setStatus(message);
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
      originalBase64: job.originalBase64,
      originalMediaType: job.originalMediaType,
      videoName: job.videoName,
      captureSeconds: job.captureSeconds,
      textOnly: !!job.textOnly,
      transcriptContext: job.transcriptContext,
      mathWarning: typeof job.mathWarning === "string" ? job.mathWarning : null,
    })),
  };
}

function loadProjectRecord(record) {
  jobs.clear();
  // Same reasoning as newBatch: the opened project's slides carry their own
  // excerpts; the session transcript belonged to whatever came before.
  workspaceTranscripts.clear();
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
  // What's saved must be what's on screen — including an unsaved edit.
  commitPendingEdit();
  setProjectsError("");
  const record = serializeProject();
  try {
    await projectStoreRequest("readwrite", (store) => store.put(record));
  } catch (err) {
    setProjectsError(`Couldn't save: ${err.message || err}`);
    return;
  }
  currentProjectId = record.id;
  markDirty(); // refresh the autosave's link to this named project
  announceProjects(`Project "${record.name}" saved.`);
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
  // Confirm whenever any batch is loaded — including re-opening the project
  // that's already open, which still discards unsaved changes made since the
  // last save (the id matching doesn't mean the content matches).
  if (jobs.size > 0) {
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
  if (currentProjectId === id) {
    currentProjectId = null;
    markDirty(); // the autosave's stored link to this project is now stale
  }
  await refreshProjectList();
}

/**
 * Swaps a project row's name for an input, in place. Enter or leaving the
 * field commits; Escape cancels — with the default prevented, since inside a
 * modal dialog an unhandled Escape means "close the whole dialog", and
 * backing out of a rename should cost exactly one press, not the dialog.
 */
function beginProjectRename(record, nameEl, renameBtn) {
  const input = document.createElement("input");
  input.className = "input project-rename-input";
  input.value = record.name;
  input.setAttribute("aria-label", `New name for project ${record.name}`);
  renameBtn.hidden = true;

  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    const newName = input.value.trim();
    if (commit && newName && newName !== record.name) {
      try {
        // Re-read rather than trusting the listing's copy — the record may
        // have been resaved since the list rendered, and putting a stale
        // copy back would quietly roll those slides over.
        const stored = await projectStoreRequest("readonly", (store) => store.get(record.id));
        if (stored) {
          stored.name = newName;
          // savedAt deliberately untouched: a rename is not new work, and
          // bumping it would reshuffle the list mid-click.
          await projectStoreRequest("readwrite", (store) => store.put(stored));
          // If this project is the open batch, the header must follow — and
          // stay followed across the autosave's reload restore.
          if (record.id === currentProjectId) {
            els.batchName.value = newName;
            els.batchName.dataset.userNamed = "1";
            markDirty();
          }
          announceProjects(`Renamed to "${newName}".`);
        }
      } catch (err) {
        setProjectsError(`Couldn't rename: ${err.message || err}`);
      }
    }
    refreshProjectList();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));

  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

async function refreshProjectList() {
  let records;
  try {
    records = await projectStoreRequest("readonly", (store) => store.getAll());
  } catch (err) {
    setProjectsError(`Couldn't read saved projects: ${err.message || err}`);
    return;
  }
  records = records.filter((r) => r.id !== AUTOSAVE_ID);
  records.sort((a, b) => b.savedAt - a.savedAt);

  els.projectList.replaceChildren();
  els.projectsEmpty.hidden = records.length > 0;

  for (const record of records) {
    const li = document.createElement("li");
    li.className = "project-row";

    const text = document.createElement("div");
    text.className = "project-text";
    const nameRow = document.createElement("div");
    nameRow.className = "project-name-row";
    const name = document.createElement("p");
    name.className = "project-name";
    name.textContent = record.name;
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "btn btn-icon project-rename";
    renameBtn.setAttribute("aria-label", `Rename project ${record.name}`);
    renameBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path></svg>';
    renameBtn.addEventListener("click", () => beginProjectRename(record, name, renameBtn));
    nameRow.append(name, renameBtn);
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
    text.append(nameRow, meta);

    // Visible labels repeat identically on every row; the aria-label carries
    // the project name so a screen reader's button list isn't just
    // "Open, Open, Open".
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn btn-small";
    openBtn.textContent = "Open";
    openBtn.setAttribute("aria-label", `Open project ${record.name}`);
    openBtn.addEventListener("click", () => openProject(record.id));

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "btn btn-small";
    exportBtn.textContent = "Export";
    exportBtn.setAttribute("aria-label", `Export project ${record.name}`);
    exportBtn.addEventListener("click", () => exportProjectRecord(record));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-small btn-ghost";
    deleteBtn.textContent = "Delete";
    deleteBtn.setAttribute("aria-label", `Delete project ${record.name}`);
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
  announceProjects(`Exported "${record.name}" as a project file.`);
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
      videoName: typeof saved.videoName === "string" ? saved.videoName : null,
      // num() maps a non-finite value to null, so a frame captured at 0:00
      // keeps its legitimate 0 while junk is discarded.
      captureSeconds: num(saved.captureSeconds),
      textOnly: !!saved.textOnly,
      // Plain text sent to the API as context, never rendered as HTML — a
      // type check is the only sanitation it needs.
      transcriptContext:
        typeof saved.transcriptContext === "string" && saved.transcriptContext
          ? saved.transcriptContext
          : null,
      mathWarning: typeof saved.mathWarning === "string" && saved.mathWarning ? saved.mathWarning : null,
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
  announceProjects(`Imported "${record.name}" — it's in the list, ready to open.`);
  await refreshProjectList();
}

els.projectsBtn.addEventListener("click", async () => {
  setProjectsError("");
  els.projectsStatus.textContent = "";
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
restoreAutosave();
