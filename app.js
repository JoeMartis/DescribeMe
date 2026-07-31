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

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const ANTHROPIC_VERSION = "2023-06-01";

const els = {
  settingsToggle: document.getElementById("settingsToggle"),
  settingsBody: document.getElementById("settingsBody"),
  apiKey: document.getElementById("apiKey"),
  toggleKeyVisibility: document.getElementById("toggleKeyVisibility"),
  baseUrl: document.getElementById("baseUrl"),
  model: document.getElementById("model"),
  clearStoredKey: document.getElementById("clearStoredKey"),
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  previewWrap: document.getElementById("previewWrap"),
  previewImg: document.getElementById("previewImg"),
  removeImage: document.getElementById("removeImage"),
  describeBtn: document.getElementById("describeBtn"),
  statusMessage: document.getElementById("statusMessage"),
  errorMessage: document.getElementById("errorMessage"),
  resultSection: document.getElementById("resultSection"),
  tabPreview: document.getElementById("tabPreview"),
  tabSource: document.getElementById("tabSource"),
  tabText: document.getElementById("tabText"),
  viewPreview: document.getElementById("viewPreview"),
  viewSource: document.getElementById("viewSource"),
  viewText: document.getElementById("viewText"),
  sourceCode: document.getElementById("sourceCode"),
  plainTextCode: document.getElementById("plainTextCode"),
  copyHtmlBtn: document.getElementById("copyHtmlBtn"),
  copyTextBtn: document.getElementById("copyTextBtn"),
};

let currentImage = null; // { base64, mediaType, name }
let lastHtml = "";
let lastText = "";

// ---------- Settings persistence ----------

const STORAGE_KEYS = {
  key: "describeme.apiKey",
  baseUrl: "describeme.baseUrl",
  model: "describeme.model",
  persistence: "describeme.keyPersistence",
};

function loadSettings() {
  const persistence =
    localStorage.getItem(STORAGE_KEYS.persistence) || "none";
  const radio = document.querySelector(
    `input[name="keyPersistence"][value="${persistence}"]`
  );
  if (radio) radio.checked = true;

  if (persistence === "local") {
    els.apiKey.value = localStorage.getItem(STORAGE_KEYS.key) || "";
  } else if (persistence === "session") {
    els.apiKey.value = sessionStorage.getItem(STORAGE_KEYS.key) || "";
  }

  const savedBaseUrl =
    localStorage.getItem(STORAGE_KEYS.baseUrl) ||
    sessionStorage.getItem(STORAGE_KEYS.baseUrl);
  if (savedBaseUrl) els.baseUrl.value = savedBaseUrl;

  const savedModel =
    localStorage.getItem(STORAGE_KEYS.model) ||
    sessionStorage.getItem(STORAGE_KEYS.model);
  if (savedModel) els.model.value = savedModel;
}

function currentPersistenceMode() {
  const checked = document.querySelector(
    'input[name="keyPersistence"]:checked'
  );
  return checked ? checked.value : "none";
}

function persistSettings() {
  const mode = currentPersistenceMode();

  // Always clear both stores first, then write to the selected one.
  localStorage.removeItem(STORAGE_KEYS.key);
  sessionStorage.removeItem(STORAGE_KEYS.key);
  localStorage.removeItem(STORAGE_KEYS.baseUrl);
  sessionStorage.removeItem(STORAGE_KEYS.baseUrl);
  localStorage.removeItem(STORAGE_KEYS.model);
  sessionStorage.removeItem(STORAGE_KEYS.model);

  localStorage.setItem(STORAGE_KEYS.persistence, mode);

  if (mode === "local") {
    localStorage.setItem(STORAGE_KEYS.key, els.apiKey.value);
    localStorage.setItem(STORAGE_KEYS.baseUrl, els.baseUrl.value);
    localStorage.setItem(STORAGE_KEYS.model, els.model.value);
  } else if (mode === "session") {
    sessionStorage.setItem(STORAGE_KEYS.key, els.apiKey.value);
    sessionStorage.setItem(STORAGE_KEYS.baseUrl, els.baseUrl.value);
    sessionStorage.setItem(STORAGE_KEYS.model, els.model.value);
  }
}

document
  .querySelectorAll('input[name="keyPersistence"]')
  .forEach((radio) => radio.addEventListener("change", persistSettings));
els.apiKey.addEventListener("input", persistSettings);
els.baseUrl.addEventListener("input", persistSettings);
els.model.addEventListener("input", persistSettings);

els.clearStoredKey.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEYS.key);
  sessionStorage.removeItem(STORAGE_KEYS.key);
  localStorage.removeItem(STORAGE_KEYS.persistence);
  els.apiKey.value = "";
  document.querySelector(
    'input[name="keyPersistence"][value="none"]'
  ).checked = true;
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

// ---------- File handling ----------

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

function handleFile(file) {
  setError("");

  if (!file) return;

  if (!ACCEPTED_TYPES.includes(file.type)) {
    setError(
      `Unsupported file type "${file.type || "unknown"}". Please use PNG, JPEG, WebP, or GIF.`
    );
    return;
  }

  if (file.size > MAX_FILE_BYTES) {
    setError(
      `That image is ${(file.size / (1024 * 1024)).toFixed(1)} MB, which is over the 5 MB limit.`
    );
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    currentImage = { base64, mediaType: file.type, name: file.name };
    els.previewImg.src = dataUrl;
    els.previewImg.alt = `Preview of uploaded slide: ${file.name}`;
    els.previewWrap.hidden = false;
    updateDescribeButtonState();
    setStatus(`Loaded "${file.name}". Ready to describe.`);
  };
  reader.onerror = () => {
    setError("Could not read that file. Please try again.");
  };
  reader.readAsDataURL(file);
}

els.fileInput.addEventListener("change", (e) => {
  handleFile(e.target.files[0]);
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
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  handleFile(file);
});

els.removeImage.addEventListener("click", () => {
  currentImage = null;
  els.fileInput.value = "";
  els.previewWrap.hidden = true;
  els.previewImg.src = "";
  updateDescribeButtonState();
  setStatus("");
});

function updateDescribeButtonState() {
  els.describeBtn.disabled = !currentImage || !els.apiKey.value.trim();
}

els.apiKey.addEventListener("input", updateDescribeButtonState);

// ---------- Describe action ----------

els.describeBtn.addEventListener("click", describeSlide);

async function describeSlide() {
  if (!currentImage) {
    setError("Please upload a slide image first.");
    return;
  }

  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    setError("Please enter your API key in API Settings.");
    return;
  }

  const baseUrl = (els.baseUrl.value.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
  const model = els.model.value.trim() || "claude-haiku-4-5";

  setError("");
  setStatus("Describing slide…");
  els.describeBtn.disabled = true;
  els.resultSection.hidden = true;

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
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
                  media_type: currentImage.mediaType,
                  data: currentImage.base64,
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

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const apiMessage =
        payload && payload.error && payload.error.message
          ? payload.error.message
          : `HTTP ${response.status}`;
      throw new Error(apiMessage);
    }

    if (!payload || !Array.isArray(payload.content)) {
      throw new Error("Unexpected response shape from the API.");
    }

    const textBlock = payload.content.find((b) => b.type === "text");
    if (!textBlock || !textBlock.text) {
      throw new Error("The model did not return any text content.");
    }

    renderResult(textBlock.text);
    setStatus("Description ready.");
  } catch (err) {
    console.error(err);
    setError(describeFetchError(err));
    setStatus("");
  } finally {
    updateDescribeButtonState();
  }
}

function describeFetchError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (msg === "Failed to fetch") {
    return (
      "Network request failed. This can happen if the API base URL is wrong, " +
      "you're offline, or the API does not allow direct browser requests from this origin (CORS)."
    );
  }
  return `Request failed: ${msg}`;
}

// ---------- Rendering & sanitizing ----------

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
  // Remove raw MathML nodes; keep their sr-note plain-language reading instead.
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

function renderResult(rawHtml) {
  const fragment = sanitizeHtmlFragment(rawHtml);

  els.viewPreview.innerHTML = "";
  els.viewPreview.appendChild(fragment.cloneNode(true));

  lastHtml = els.viewPreview.innerHTML;
  els.sourceCode.textContent = lastHtml;

  lastText = domFragmentToText(fragment);
  els.plainTextCode.textContent = lastText;

  els.resultSection.hidden = false;
  els.resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Tabs ----------

const tabs = [
  { btn: els.tabPreview, panel: els.viewPreview },
  { btn: els.tabSource, panel: els.viewSource },
  { btn: els.tabText, panel: els.viewText },
];

tabs.forEach(({ btn, panel }) => {
  btn.addEventListener("click", () => {
    tabs.forEach(({ btn: b, panel: p }) => {
      const active = b === btn;
      b.setAttribute("aria-selected", String(active));
      b.classList.toggle("active", active);
      p.hidden = !active;
    });
    panel.focus?.();
  });
});

// ---------- Copy buttons ----------

async function copyToClipboard(text, button, label) {
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

els.copyHtmlBtn.addEventListener("click", () => {
  copyToClipboard(lastHtml, els.copyHtmlBtn, "HTML");
});

els.copyTextBtn.addEventListener("click", () => {
  copyToClipboard(lastText, els.copyTextBtn, "text");
});

// ---------- Init ----------

loadSettings();
updateDescribeButtonState();
