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
- Explain what the figure demonstrates — that's why it's on the slide.

Data and charts
- Give chart type, axes, ranges, and units, then the trend and the specific
  values that matter. Put discrete data in a <table> with <th> headers.

Color, emphasis, callouts
- Describe these by function, not appearance: what a highlighted term signifies,
  not that it is red or boxed.

Constraints
- Include only what is present on the slide. Do not infer values, add outside
  facts, or editorialize.
- Be complete but not padded; every sentence should carry information a sighted
  viewer would receive.
- Do not start with "This slide" but rather name the type of visual diagram on the slide, such as "A line graph shows…" "A diagram illustrates." etc.

OUTPUT: Return the HTML only — no code fences, no commentary — ready to embed, using semantic screen-reader-friendly markup.`;

// ---------- Tunables ----------

const MAX_FILE_BYTES = 5 * 1024 * 1024;
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

const els = {
  settingsToggle: document.getElementById("settingsToggle"),
  settingsBody: document.getElementById("settingsBody"),
  apiKey: document.getElementById("apiKey"),
  toggleKeyVisibility: document.getElementById("toggleKeyVisibility"),
  model: document.getElementById("model"),
  concurrency: document.getElementById("concurrency"),
  clearStoredKey: document.getElementById("clearStoredKey"),
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  imageList: document.getElementById("imageList"),
  describeBtn: document.getElementById("describeBtn"),
  stopBtn: document.getElementById("stopBtn"),
  clearAllBtn: document.getElementById("clearAllBtn"),
  statusMessage: document.getElementById("statusMessage"),
  errorMessage: document.getElementById("errorMessage"),
  imageCardTemplate: document.getElementById("imageCardTemplate"),
};

/** @type {Map<string, object>} jobId -> job */
const jobs = new Map();
let jobSeq = 0;
let batchRunning = false;
let cancelRequested = false;
const inFlightControllers = new Set();

// ---------- Settings persistence ----------

const STORAGE_KEYS = {
  key: "describeme.apiKey",
  model: "describeme.model",
  concurrency: "describeme.concurrency",
  persistence: "describeme.keyPersistence",
};

function loadSettings() {
  const persistence = localStorage.getItem(STORAGE_KEYS.persistence) || "none";
  const radio = document.querySelector(
    `input[name="keyPersistence"][value="${persistence}"]`
  );
  if (radio) radio.checked = true;

  if (persistence === "local") {
    els.apiKey.value = localStorage.getItem(STORAGE_KEYS.key) || "";
  } else if (persistence === "session") {
    els.apiKey.value = sessionStorage.getItem(STORAGE_KEYS.key) || "";
  }

  const savedModel =
    localStorage.getItem(STORAGE_KEYS.model) ||
    sessionStorage.getItem(STORAGE_KEYS.model);
  if (savedModel) els.model.value = savedModel;

  const savedConcurrency =
    localStorage.getItem(STORAGE_KEYS.concurrency) ||
    sessionStorage.getItem(STORAGE_KEYS.concurrency);
  if (savedConcurrency) els.concurrency.value = savedConcurrency;
}

function currentPersistenceMode() {
  const checked = document.querySelector('input[name="keyPersistence"]:checked');
  return checked ? checked.value : "none";
}

function persistSettings() {
  const mode = currentPersistenceMode();

  [STORAGE_KEYS.key, STORAGE_KEYS.model, STORAGE_KEYS.concurrency].forEach((k) => {
    localStorage.removeItem(k);
    sessionStorage.removeItem(k);
  });

  localStorage.setItem(STORAGE_KEYS.persistence, mode);

  if (mode === "local" || mode === "session") {
    const store = mode === "local" ? localStorage : sessionStorage;
    store.setItem(STORAGE_KEYS.key, els.apiKey.value);
    store.setItem(STORAGE_KEYS.model, els.model.value);
    store.setItem(STORAGE_KEYS.concurrency, els.concurrency.value);
  }
}

document
  .querySelectorAll('input[name="keyPersistence"]')
  .forEach((radio) => radio.addEventListener("change", persistSettings));
els.apiKey.addEventListener("input", persistSettings);
els.model.addEventListener("input", persistSettings);
els.concurrency.addEventListener("input", persistSettings);

els.clearStoredKey.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEYS.key);
  sessionStorage.removeItem(STORAGE_KEYS.key);
  localStorage.removeItem(STORAGE_KEYS.persistence);
  els.apiKey.value = "";
  document.querySelector('input[name="keyPersistence"][value="none"]').checked = true;
  setStatus("Stored API key cleared.");
});

// ---------- Settings panel disclosure ----------

els.settingsToggle.addEventListener("click", () => {
  const expanded = els.settingsToggle.getAttribute("aria-expanded") === "true";
  els.settingsToggle.setAttribute("aria-expanded", String(!expanded));
  els.settingsBody.hidden = expanded;
});

els.toggleKeyVisibility.addEventListener("click", () => {
  const isPassword = els.apiKey.type === "password";
  els.apiKey.type = isPassword ? "text" : "password";
  els.toggleKeyVisibility.setAttribute("aria-pressed", String(isPassword));
  els.toggleKeyVisibility.textContent = isPassword ? "Hide" : "Show";
});

// ---------- Status / error helpers ----------

function setStatus(message) {
  els.statusMessage.textContent = message;
}

function setError(message) {
  if (message) {
    els.errorMessage.textContent = message;
    els.errorMessage.hidden = false;
  } else {
    els.errorMessage.textContent = "";
    els.errorMessage.hidden = true;
  }
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

  if (!needsResize) {
    return {
      dataUrl,
      base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      mediaType: file.type,
      width: img.naturalWidth,
      height: img.naturalHeight,
      resized: false,
    };
  }

  const scale = MAX_IMAGE_EDGE / longestEdge;
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

  return {
    dataUrl: resizedDataUrl,
    base64: resizedDataUrl.slice(resizedDataUrl.indexOf(",") + 1),
    mediaType,
    width: targetW,
    height: targetH,
    resized: true,
    originalWidth: img.naturalWidth,
    originalHeight: img.naturalHeight,
  };
}

// ---------- Queue management ----------

function makeJobId() {
  jobSeq += 1;
  return `job-${jobSeq}`;
}

function createJobCard(job) {
  const fragment = els.imageCardTemplate.content.cloneNode(true);
  const li = fragment.querySelector(".image-card");
  li.dataset.jobId = job.id;

  const thumb = li.querySelector(".thumb");
  thumb.src = job.previewDataUrl;
  thumb.alt = "";

  li.querySelector(".image-card-name").textContent = job.name;

  li.querySelector(".retry-btn").addEventListener("click", () => retryJob(job.id));
  li.querySelector(".remove-btn").addEventListener("click", () => removeJob(job.id));
  li.querySelector(".copy-html-btn").addEventListener("click", (e) => {
    copyToClipboard(job.resultHtml, e.currentTarget, "HTML");
  });
  li.querySelector(".copy-text-btn").addEventListener("click", (e) => {
    copyToClipboard(job.resultText, e.currentTarget, "text");
  });

  els.imageList.appendChild(fragment);
  job.el = els.imageList.querySelector(`[data-job-id="${job.id}"]`);
  renderJobState(job);
}

function renderJobState(job) {
  const el = job.el;
  if (!el) return;
  el.dataset.state = job.state;

  const statusEl = el.querySelector(".image-card-status");
  const retryBtn = el.querySelector(".retry-btn");
  const resultArea = el.querySelector(".result-area");

  switch (job.state) {
    case "pending":
      statusEl.textContent = job.resized
        ? `Ready (resized ${job.originalWidth}×${job.originalHeight} → ${job.width}×${job.height} for a smaller, faster request)`
        : "Ready";
      retryBtn.hidden = true;
      resultArea.hidden = true;
      break;
    case "describing":
      statusEl.textContent =
        job.attempt > 1 ? `Describing… (retry ${job.attempt - 1})` : "Describing…";
      retryBtn.hidden = true;
      resultArea.hidden = true;
      break;
    case "done":
      statusEl.textContent = "Done";
      retryBtn.hidden = true;
      resultArea.hidden = false;
      break;
    case "error":
      statusEl.textContent = `Failed: ${job.error || "unknown error"}`;
      retryBtn.hidden = false;
      resultArea.hidden = true;
      break;
    case "canceled":
      statusEl.textContent = "Canceled";
      retryBtn.hidden = false;
      resultArea.hidden = true;
      break;
    case "invalid":
      statusEl.textContent = `Couldn't load this image: ${job.error || "unknown error"}`;
      retryBtn.hidden = true;
      resultArea.hidden = true;
      break;
  }

  updateDescribeButtonState();
  updateOverallStatus();
}

async function addFiles(fileList) {
  setError("");
  const files = Array.from(fileList);
  if (files.length === 0) return;

  const room = MAX_BATCH_SIZE - jobs.size;
  if (room <= 0) {
    setError(`You already have the maximum of ${MAX_BATCH_SIZE} images queued.`);
    return;
  }
  const toAdd = files.slice(0, room);
  if (files.length > toAdd.length) {
    setError(
      `Only added ${toAdd.length} of ${files.length} files — batches are capped at ${MAX_BATCH_SIZE} images.`
    );
  }

  for (const file of toAdd) {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError(`Skipped "${file.name}": unsupported type "${file.type || "unknown"}".`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(
        `Skipped "${file.name}": ${(file.size / (1024 * 1024)).toFixed(1)} MB is over the 5 MB limit.`
      );
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
      el: null,
    };
    jobs.set(job.id, job);

    try {
      const prepared = await prepareImageForUpload(file);
      Object.assign(job, prepared, { previewDataUrl: prepared.dataUrl });
      createJobCard(job);
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
      createJobCard(job);
    }
  }

  updateDescribeButtonState();
  updateOverallStatus();
}

function removeJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.state === "describing") return; // don't remove mid-flight
  job.el?.remove();
  jobs.delete(jobId);
  updateDescribeButtonState();
  updateOverallStatus();
}

function retryJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.state = "pending";
  job.error = null;
  job.attempt = 0;
  renderJobState(job);
  updateDescribeButtonState();
}

els.clearAllBtn.addEventListener("click", () => {
  if (batchRunning) return;
  jobs.clear();
  els.imageList.innerHTML = "";
  updateDescribeButtonState();
  updateOverallStatus();
  setError("");
});

function updateDescribeButtonState() {
  const hasApiKey = !!els.apiKey.value.trim();
  const hasRunnable = [...jobs.values()].some(
    (j) => j.state === "pending" || j.state === "error" || j.state === "canceled"
  );
  els.describeBtn.disabled = batchRunning || !hasApiKey || !hasRunnable;
  els.clearAllBtn.hidden = jobs.size === 0 || batchRunning;
}

els.apiKey.addEventListener("input", updateDescribeButtonState);

function updateOverallStatus() {
  if (jobs.size === 0) {
    if (!batchRunning) setStatus("");
    return;
  }
  const counts = { pending: 0, describing: 0, done: 0, error: 0, canceled: 0 };
  jobs.forEach((j) => (counts[j.state] = (counts[j.state] || 0) + 1));

  if (batchRunning) {
    setStatus(
      `Describing… ${counts.done} done, ${counts.describing} in progress, ` +
        `${counts.pending} queued${counts.error ? `, ${counts.error} failed` : ""}.`
    );
  } else if (counts.done > 0 || counts.error > 0 || counts.invalid > 0) {
    const parts = [`${counts.done} of ${jobs.size} described`];
    if (counts.error) parts.push(`${counts.error} failed`);
    if (counts.canceled) parts.push(`${counts.canceled} canceled`);
    if (counts.invalid) parts.push(`${counts.invalid} couldn't be loaded`);
    setStatus(parts.join(", ") + ".");
  }
}

// ---------- File input / drag & drop ----------

els.fileInput.addEventListener("change", (e) => {
  addFiles(e.target.files);
  els.fileInput.value = "";
});

els.dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.fileInput.click();
  }
});

["dragenter", "dragover"].forEach((evt) => {
  els.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((evt) => {
  els.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropZone.classList.remove("dragover");
  });
});

els.dropZone.addEventListener("drop", (e) => {
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    addFiles(e.dataTransfer.files);
  }
});

// ---------- Batch processing ----------

els.describeBtn.addEventListener("click", runBatch);
els.stopBtn.addEventListener("click", () => {
  cancelRequested = true;
  els.stopBtn.disabled = true;
  setStatus("Stopping — finishing in-flight requests…");
  inFlightControllers.forEach((c) => c.abort());
});

async function runBatch() {
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    setError("Please enter your API key in API Settings.");
    return;
  }

  const runnable = [...jobs.values()].filter(
    (j) => j.state === "pending" || j.state === "error" || j.state === "canceled"
  );
  if (runnable.length === 0) return;

  const model = els.model.value.trim() || "claude-haiku-4-5";
  const concurrency = Math.min(
    6,
    Math.max(1, parseInt(els.concurrency.value, 10) || 3)
  );

  setError("");
  batchRunning = true;
  cancelRequested = false;
  els.describeBtn.disabled = true;
  els.stopBtn.hidden = false;
  els.stopBtn.disabled = false;
  els.clearAllBtn.hidden = true;
  updateOverallStatus();

  runnable.forEach((job) => {
    job.attempt = 0;
    job.error = null;
  });

  await runWithConcurrency(runnable, concurrency, (job) =>
    describeOne(job, { apiKey, model })
  );

  batchRunning = false;
  els.stopBtn.hidden = true;
  updateDescribeButtonState();
  updateOverallStatus();
}

async function runWithConcurrency(items, limit, worker) {
  let idx = 0;
  const poolSize = Math.min(limit, items.length);
  const pool = new Array(poolSize).fill(null).map(async () => {
    while (idx < items.length) {
      if (cancelRequested) {
        const remaining = items[idx++];
        if (remaining.state === "pending" || remaining.state === "describing") {
          remaining.state = "canceled";
          renderJobState(remaining);
        }
        continue;
      }
      const item = items[idx++];
      await worker(item);
    }
  });
  await Promise.all(pool);
}

async function describeOne(job, { apiKey, model }) {
  job.state = "describing";
  job.attempt = 1;
  renderJobState(job);

  while (true) {
    if (cancelRequested) {
      job.state = "canceled";
      renderJobState(job);
      return;
    }

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
          system: SYSTEM_PROMPT,
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
                  text: "Describe this STEM lecture slide following the system instructions.",
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
  ]);

  const walk = (node) => {
    [...node.querySelectorAll("*")].forEach((el) => {
      if (DISALLOWED_TAGS.has(el.tagName)) {
        el.remove();
        return;
      }
      [...el.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith("on")) {
          el.removeAttribute(attr.name);
        } else if (
          (name === "href" || name === "src" || name === "xlink:href") &&
          (value.startsWith("javascript:") || value.startsWith("data:text/html"))
        ) {
          el.removeAttribute(attr.name);
        }
      });
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

  const previewEl = job.el.querySelector(".result-preview");
  previewEl.innerHTML = "";
  previewEl.appendChild(fragment.cloneNode(true));

  job.resultHtml = previewEl.innerHTML;
  job.el.querySelector(".source-code").textContent = job.resultHtml;
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

// ---------- Init ----------

loadSettings();
updateDescribeButtonState();
