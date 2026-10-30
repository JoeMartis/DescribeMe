// The learner PDF: the learner HTML document, typeset by Typst into a tagged
// PDF that claims PDF/UA-1.
//
// Loaded only when someone asks for a PDF (app.js imports it on demand), so
// nobody else pays for the typesetter — about 11 MB over the network the first
// time, cached by the browser after that. Everything here runs in the page:
// the compiler is WebAssembly, the fonts and the speech rules are files in
// vendor/, and nothing is fetched from anywhere but this site. See
// vendor/README.md for what each file is and where it came from.
//
// Why the PDF is built from the HTML rather than from the descriptions
// directly: the two downloads must say the same thing. Building one from the
// other means a fix to either is a fix to both.
//
// Equations are the one place the two differ. In HTML, MathML is the
// accessible form — screen readers read it and let a learner move through it.
// In a PDF they do not: PDF/UA-1 has no MathML, and readers speak a formula
// from its alt text. So each equation's alt text is a spoken reading,
// generated here by Speech Rule Engine from the MathML (never by the model,
// and never shown on the page).

import initTypst, { TypstCompilerBuilder } from "./vendor/typst/typst_ts_web_compiler.mjs";

const VENDOR = new URL("./vendor/", import.meta.url);

const FONT_FILES = [
  "fonts/LibertinusSerif-Regular.otf",
  "fonts/LibertinusSerif-Bold.otf",
  "fonts/LibertinusSerif-Italic.otf",
  "fonts/LibertinusSerif-BoldItalic.otf",
  "fonts/NewCMMath-Regular.otf",
  "fonts/DejaVuSansMono.ttf",
];

// ---------- Loading the typesetter and the speech engine ----------

let compilerPromise = null;

function loadCompiler() {
  if (!compilerPromise) {
    compilerPromise = (async () => {
      await initTypst({ module_or_path: new URL("typst/typst_ts_web_compiler_bg.wasm", VENDOR) });
      const builder = new TypstCompilerBuilder();
      // No file system, no package registry: every file the document uses is
      // handed over with map_shadow, so a stray #import cannot reach out.
      builder.set_dummy_access_model();
      // Fetched side by side, added in order.
      const fonts = await Promise.all(
        FONT_FILES.map(async (file) => {
          const res = await fetch(new URL(file, VENDOR));
          if (!res.ok) throw new Error(`Couldn't load ${file} (${res.status}).`);
          return new Uint8Array(await res.arrayBuffer());
        })
      );
      for (const font of fonts) await builder.add_raw_font(font);
      return builder.build();
    })();
    // A failed load must not stick: the next click should try again rather
    // than replay the same rejection forever.
    compilerPromise.catch(() => { compilerPromise = null; });
  }
  return compilerPromise;
}

let speechPromise = null;

function loadSpeech() {
  if (!speechPromise) {
    speechPromise = new Promise((resolve, reject) => {
      // Read once, when sre.js loads. Without it the engine fetches its rules
      // from a CDN before any setup call can redirect it — which the CSP
      // blocks, and which would send a request off this site if it did not.
      window.SREfeature = { json: new URL("sre/mathmaps", VENDOR).href, locale: "en", domain: "clearspeak" };
      const script = document.createElement("script");
      script.src = new URL("sre/sre.js", VENDOR).href;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Couldn't load the speech engine."));
      document.head.appendChild(script);
    }).then(async () => {
      // ClearSpeak's default reads a capital delta before letters as
      // geometry: "triangle G" for ΔG. In lecture slides it is a change in a
      // quantity, so it is read as "Delta".
      await window.SRE.setupEngine({ locale: "en", domain: "clearspeak", modality: "speech", style: "TriangleSymbol_Delta" });
      await window.SRE.engineReady();
    });
    speechPromise.catch(() => { speechPromise = null; });
  }
  return speechPromise;
}

// ---------- Spoken readings ----------

const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

// A chemical element symbol: one capital, optionally one lowercase letter.
const ELEMENT_RE = /^[A-Z][a-z]?$/;

function scriptBase(el) {
  if (!el || el.namespaceURI !== MATHML_NS) return null;
  const name = el.localName;
  if (name === "mi") return el.textContent.trim();
  if (name === "msub" || name === "msup" || name === "msubsup") {
    const base = el.firstElementChild;
    return base && base.localName === "mi" ? base.textContent.trim() : null;
  }
  return null;
}

/**
 * The model writes H₂O as <msub>H 2</msub><mi>O</mi>, with nothing between
 * the two — and Speech Rule Engine reads that as a function applied to O:
 * "H sub 2 of O". Between two element symbols where one is subscripted, an
 * invisible times is what the MathML meant, and with it the reading is
 * "H sub 2 O". Applied to the copy that is spoken, never the one typeset.
 */
function markChemistry(math) {
  for (const row of [math, ...math.querySelectorAll("*")]) {
    const kids = [...row.children];
    for (let i = 0; i < kids.length - 1; i += 1) {
      const a = kids[i];
      const b = kids[i + 1];
      const aBase = scriptBase(a);
      const bBase = scriptBase(b);
      if (!aBase || !bBase || !ELEMENT_RE.test(aBase) || !ELEMENT_RE.test(bBase)) continue;
      if (a.localName === "mi" && b.localName === "mi") continue; // "AB" — two plain letters, leave it
      const times = document.createElementNS(MATHML_NS, "mo");
      times.textContent = "\u2062";
      a.after(times);
    }
  }
  return math;
}

function speak(math) {
  const fallback = math.textContent.replace(/\s+/g, " ").trim() || "equation";
  try {
    const copy = markChemistry(math.cloneNode(true));
    const spoken = String(window.SRE.toSpeech(new XMLSerializer().serializeToString(copy)) || "").trim();
    return spoken || fallback;
  } catch (_err) {
    return fallback;
  }
}

// ---------- MathML → Typst math ----------

// ASCII characters with a meaning of their own in Typst math. Everything the
// MathML says literally is escaped, so "a/b" stays a slash rather than
// becoming a fraction, and a comma stays a comma inside frac( , ).
const MATH_ESCAPE = new Set([..."\\$#_^&/()[]{}\"'*@<>|~,;:!.=+-?%`"]);
const INVISIBLE = new Set(["\u2061", "\u2062", "\u2063", "\u2064"]);

const typstString = (text) => `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function mathChar(ch) {
  if (INVISIBLE.has(ch)) return "";
  if (MATH_ESCAPE.has(ch)) return `\\${ch}`;
  return ch;
}

function mathChars(text) {
  return [...text].map(mathChar).filter(Boolean).join(" ");
}

// Accents that sit over a base, and the Typst function for each.
const OVER_ACCENTS = {
  "^": "hat", "\u02c6": "hat", "\u0302": "hat",
  "~": "tilde", "\u02dc": "tilde", "\u0303": "tilde",
  "\u02d9": "dot", "\u0307": "dot", "\u00a8": "dot.double", "\u0308": "dot.double",
  "\u2192": "arrow", "\u20d7": "arrow",
  "\u02c7": "caron", "\u030c": "caron",
};
const OVERLINES = new Set(["\u00af", "\u0305", "\u203e", "_", "\u2015", "\u2014", "\u2013"]);
const BRACES = { "\u23de": "overbrace", "\u23df": "underbrace", "\ufe37": "overbrace", "\ufe38": "underbrace" };

const arg = (s) => (s && s.trim() ? s : '""');

function mathKids(el) {
  return [...el.children].map(mathNode).filter((s) => s !== "").join(" ");
}

function mathNode(el) {
  const name = el.localName;
  const kids = [...el.children];
  const text = el.textContent.replace(/\s+/g, " ").trim();
  switch (name) {
    case "math":
    case "mrow":
    case "mstyle":
    case "mpadded":
    case "menclose":
    case "merror":
      return fencedRow(el) ?? mathKids(el);
    case "semantics":
      return kids[0] ? mathNode(kids[0]) : "";
    case "annotation":
    case "annotation-xml":
    case "mphantom":
    case "none":
    case "mprescripts":
      return "";
    case "mi": {
      if (!text) return "";
      const chars = [...text];
      if (chars.length === 1) {
        const ch = chars[0];
        if (el.getAttribute("mathvariant") === "normal" && /\p{L}/u.test(ch)) return `upright(${ch})`;
        return /\p{L}/u.test(ch) ? ch : mathChar(ch);
      }
      return typstString(text);
    }
    case "mn":
      return /^[0-9]+(\.[0-9]+)?$/.test(text) ? text : typstString(text);
    case "mo":
      if (!text || [...text].every((ch) => INVISIBLE.has(ch))) return "";
      if (/^\p{L}+$/u.test(text)) return `op(${typstString(text)})`;
      return mathChars(text);
    case "mtext":
    case "ms":
      return text ? typstString(el.textContent.replace(/\s+/g, " ")) : "";
    case "mspace":
      return "thin";
    case "msub":
      return `attach(${arg(part(kids[0]))}, b: ${arg(part(kids[1]))})`;
    case "msup":
      return `attach(${arg(part(kids[0]))}, t: ${arg(part(kids[1]))})`;
    case "msubsup":
      return `attach(${arg(part(kids[0]))}, b: ${arg(part(kids[1]))}, t: ${arg(part(kids[2]))})`;
    case "mfrac":
      return `frac(${arg(part(kids[0]))}, ${arg(part(kids[1]))})`;
    case "msqrt":
      return `sqrt(${arg(mathKids(el))})`;
    case "mroot":
      return `root(${arg(part(kids[1]))}, ${arg(part(kids[0]))})`;
    case "mover":
      return over(kids[0], kids[1]);
    case "munder":
      return under(kids[0], kids[1]);
    case "munderover":
      return `attach(limits(${arg(part(kids[0]))}), b: ${arg(part(kids[1]))}, t: ${arg(part(kids[2]))})`;
    case "mmultiscripts":
      return multiscripts(kids);
    case "mtable":
      return table(el);
    case "mtr":
    case "mlabeledtr":
    case "mtd":
      return mathKids(el);
    case "mfenced": {
      const open = el.getAttribute("open") ?? "(";
      const close = el.getAttribute("close") ?? ")";
      const sep = (el.getAttribute("separators") ?? ",").trim()[0] || "";
      const inner = kids.map(mathNode).join(sep ? ` ${mathChar(sep)} ` : " ");
      return `lr(${mathChars(open)} ${inner} ${mathChars(close)})`;
    }
    default:
      return mathKids(el);
  }
}

const part = (el) => (el ? mathNode(el) : "");

/** A row that opens and closes on a fence pair grows with its contents. */
function fencedRow(el) {
  const kids = [...el.children];
  if (kids.length < 2) return null;
  const first = kids[0];
  const last = kids[kids.length - 1];
  if (first.localName !== "mo" || last.localName !== "mo") return null;
  const pairs = { "(": ")", "[": "]", "{": "}", "|": "|", "\u2016": "\u2016", "\u27e8": "\u27e9", "\u2308": "\u2309", "\u230a": "\u230b" };
  const open = first.textContent.trim();
  const close = last.textContent.trim();
  if (pairs[open] !== close) return null;
  const inner = kids.slice(1, -1).map(mathNode).filter((s) => s !== "").join(" ");
  return `lr(${mathChar(open)} ${inner} ${mathChar(close)})`;
}

function over(base, script) {
  const mark = script ? script.textContent.trim() : "";
  const b = arg(part(base));
  if (OVERLINES.has(mark)) return `overline(${b})`;
  if (BRACES[mark] === "overbrace") return `overbrace(${b})`;
  if (OVER_ACCENTS[mark]) return `accent(${b}, ${OVER_ACCENTS[mark]})`;
  return `attach(limits(${b}), t: ${arg(part(script))})`;
}

function under(base, script) {
  const mark = script ? script.textContent.trim() : "";
  const b = arg(part(base));
  if (OVERLINES.has(mark)) return `underline(${b})`;
  if (BRACES[mark] === "underbrace") return `underbrace(${b})`;
  return `attach(limits(${b}), b: ${arg(part(script))})`;
}

function multiscripts(kids) {
  const base = arg(part(kids[0]));
  const post = [];
  const pre = [];
  let target = post;
  for (const k of kids.slice(1)) {
    if (k.localName === "mprescripts") { target = pre; continue; }
    target.push(k);
  }
  const named = [];
  const add = (key, el) => { const s = el && el.localName !== "none" ? part(el) : ""; if (s.trim()) named.push(`${key}: ${s}`); };
  add("br", post[0]); add("tr", post[1]); add("bl", pre[0]); add("tl", pre[1]);
  return named.length ? `attach(${base}, ${named.join(", ")})` : base;
}

function table(el) {
  const rows = [...el.children].filter((r) => r.localName === "mtr" || r.localName === "mlabeledtr");
  if (rows.length === 0) return "";
  const body = rows
    .map((r) => [...r.children].filter((c) => c.localName === "mtd").map((c) => arg(mathKids(c))).join(", "))
    .join("; ");
  return `mat(delim: #none, ${body})`;
}

/** The Typst for one <math>, alt text and all. */
function equation(math, block) {
  // Trimmed: Typst reads "$ x $", with spaces inside, as display math.
  const body = mathNode(math).trim();
  if (!body) return "";
  return `#math.equation(block: ${block}, alt: ${typstString(speak(math))})[$${body}$]`;
}

// ---------- HTML → Typst markup ----------
//
// Text goes in as Typst strings (#"…"), never as markup, so nothing a
// description says — an asterisk, a hash, an equals sign at a line start —
// can turn into formatting or code. Structure is all function calls.

const INLINE = new Set(["A", "ABBR", "B", "BR", "CITE", "CODE", "DFN", "EM", "I", "KBD", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "U", "VAR", "MATH"]);

const isInline = (node) =>
  node.nodeType === Node.TEXT_NODE || (node.nodeType === Node.ELEMENT_NODE && INLINE.has(node.nodeName.toUpperCase()) && !(node.localName === "math" && node.getAttribute("display") === "block"));

function inline(node, ctx) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.data.replace(/\s+/g, " ");
    return text ? `#${typstString(text)}` : "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  if (node.namespaceURI === MATHML_NS) {
    return node.localName === "math" ? equation(node, node.getAttribute("display") === "block") : "";
  }
  const inner = () => [...node.childNodes].map((n) => inline(n, ctx)).join("");
  switch (node.nodeName) {
    case "STRONG":
    case "B":
      return `#strong[${inner()}]`;
    case "EM":
    case "I":
    case "CITE":
    case "DFN":
    case "VAR":
      return `#emph[${inner()}]`;
    case "SUB":
      return `#sub[${inner()}]`;
    case "SUP":
      return `#super[${inner()}]`;
    case "U":
      return `#underline[${inner()}]`;
    case "S":
      return `#strike[${inner()}]`;
    case "CODE":
    case "KBD":
    case "SAMP":
      return `#raw(${typstString(node.textContent)})`;
    case "BR":
      return "#linebreak()";
    case "A": {
      const href = node.getAttribute("href") || "";
      return /^(https:|mailto:)/i.test(href) ? `#link(${typstString(href)})[${inner()}]` : inner();
    }
    case "IMG":
      return image(node, ctx);
    default:
      return inner();
  }
}

/** Runs of inline nodes become paragraphs; block nodes convert on their own. */
function blocks(parent, ctx) {
  const out = [];
  let run = [];
  const flush = () => {
    const text = run.map((n) => inline(n, ctx)).join("");
    run = [];
    if (text.replace(/#"\s*"/g, "").trim()) out.push(text.trim());
  };
  for (const node of parent.childNodes) {
    if (isInline(node)) { run.push(node); continue; }
    flush();
    const b = block(node, ctx);
    if (b) out.push(b);
  }
  flush();
  return out.join("\n\n");
}

const hasBlockChild = (el) => [...el.childNodes].some((n) => n.nodeType === Node.ELEMENT_NODE && !isInline(n));

function content(el, ctx) {
  return hasBlockChild(el) ? blocks(el, ctx) : [...el.childNodes].map((n) => inline(n, ctx)).join("").trim();
}

function block(node, ctx) {
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  if (node.namespaceURI === MATHML_NS) {
    return node.localName === "math" ? equation(node, node.getAttribute("display") === "block") : "";
  }
  switch (node.nodeName) {
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
      return `#heading(level: ${node.nodeName[1]})[${content(node, ctx)}]`;
    case "P":
      return content(node, ctx);
    case "UL":
    case "OL": {
      const items = [...node.children].filter((li) => li.nodeName === "LI").map((li) => `[${content(li, ctx)}]`);
      if (items.length === 0) return "";
      if (node.nodeName === "UL") return `#list(${items.join(", ")})`;
      const start = Number(node.getAttribute("start"));
      return `#enum(${Number.isInteger(start) && start !== 1 ? `start: ${start}, ` : ""}${items.join(", ")})`;
    }
    case "TABLE":
      return tableBlock(node, ctx);
    case "FIGURE":
      return blocks(node, ctx);
    case "FIGCAPTION":
      return content(node, ctx);
    case "IMG":
      return image(node, ctx);
    case "BLOCKQUOTE":
      return `#quote(block: true)[${blocks(node, ctx)}]`;
    case "PRE":
      return `#raw(block: true, ${typstString(node.textContent.replace(/\n$/, ""))})`;
    case "HR":
      return "#line(length: 100%, stroke: 0.5pt + luma(60%))";
    case "DL":
      return [...node.children]
        .map((c) => (c.nodeName === "DT" ? `#strong[${content(c, ctx)}]` : c.nodeName === "DD" ? `#pad(left: 1.5em)[${content(c, ctx)}]` : ""))
        .filter(Boolean)
        .join("\n\n");
    case "SCRIPT":
    case "STYLE":
    case "TEMPLATE":
      return "";
    default:
      return blocks(node, ctx);
  }
}

function tableBlock(tableEl, ctx) {
  const rows = [...tableEl.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr")];
  if (rows.length === 0) return "";
  const cell = (c) => {
    const span = [];
    const colspan = Number(c.getAttribute("colspan")) || 1;
    const rowspan = Number(c.getAttribute("rowspan")) || 1;
    if (colspan > 1) span.push(`colspan: ${colspan}`);
    if (rowspan > 1) span.push(`rowspan: ${rowspan}`);
    const body = content(c, ctx);
    const inner = c.nodeName === "TH" && c.closest("thead") === null ? `#strong[${body}]` : body;
    return span.length ? `table.cell(${span.join(", ")})[${inner}]` : `[${inner}]`;
  };
  // Header rows: a <thead>, or — what the model often writes instead — a
  // first row made only of <th>. Either way they become table.header, which
  // is what tags them TH for a screen reader.
  let headerRows = rows.filter((r) => r.parentElement.nodeName === "THEAD");
  if (headerRows.length === 0 && [...rows[0].children].every((c) => c.nodeName === "TH")) headerRows = [rows[0]];
  const bodyRows = rows.filter((r) => !headerRows.includes(r));
  const columns = Math.max(1, ...rows.map((r) => [...r.children].reduce((n, c) => n + (Number(c.getAttribute("colspan")) || 1), 0)));
  const headCells = headerRows.flatMap((r) => [...r.children].map((c) => {
    const span = Number(c.getAttribute("colspan")) || 1;
    const body = `#strong[${content(c, ctx)}]`;
    return span > 1 ? `table.cell(colspan: ${span})[${body}]` : `[${body}]`;
  }));
  const bodyCells = bodyRows.flatMap((r) => [...r.children].map(cell));
  const caption = tableEl.querySelector(":scope > caption");
  const head = headCells.length ? `table.header(${headCells.join(", ")}), ` : "";
  const typst = `#table(columns: ${columns}, ${head}${bodyCells.join(", ")})`;
  return caption ? `${content(caption, ctx)}\n\n${typst}` : typst;
}

/**
 * The slide image. In the HTML it has alt="" — the description that follows
 * it is the text alternative — and the PDF says the same thing the PDF way:
 * an artifact, which a screen reader passes over. A Figure with no alt text
 * would fail PDF/UA, and alt text that repeated the description would make
 * a listener hear it twice.
 */
function image(img, ctx) {
  const src = img.getAttribute("src") || "";
  const m = src.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
  if (!m) return "";
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[m[1]];
  const path = `/images/visual-${ctx.images.size + 1}.${ext}`;
  ctx.images.set(path, base64ToBytes(m[2]));
  // A wide slide fills the text column; a small one keeps its size, at
  // 96 px to the inch, rather than being blown up into a blur.
  const px = Number(img.getAttribute("width")) || 0;
  const width = px && px < 624 ? `${Math.round(px * 0.75)}pt` : "100%";
  // The hairline matches the HTML's border: a slide with a white background
  // otherwise has no edge on a white page.
  return `#pdf.artifact(block(above: 1em, below: 1em, stroke: 0.5pt + luma(75%), image(${typstString(path)}, width: ${width})))`;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const PREAMBLE = (title, lang) => `#set document(title: ${typstString(title)})
#set text(lang: ${typstString(lang)}, font: "Libertinus Serif", size: 12pt)
#set page(paper: "us-letter", margin: 1in, numbering: "1")
#set par(leading: 0.8em, spacing: 1.3em)
#show heading: set block(above: 1.8em, below: 0.9em)
#show heading.where(level: 1): set text(size: 1.6em)
#show heading.where(level: 2): set text(size: 1.25em)
#show math.equation: set text(font: "New Computer Modern Math")
#show raw: set text(font: "DejaVu Sans Mono", size: 0.9em)
#set table(inset: 6pt, stroke: 0.5pt + luma(55%))
`;

/**
 * Typst source for a learner document: the parsed learner HTML, its <main>
 * converted. Exported so the tests can read what was generated.
 */
export function learnerTypst(doc) {
  const ctx = { images: new Map() };
  const title = doc.title || "Visual descriptions";
  const lang = doc.documentElement.getAttribute("lang") || "en";
  const main = doc.querySelector("main") || doc.body;
  const body = blocks(main, ctx);
  return { source: `${PREAMBLE(title, lang)}\n${body}\n`, images: ctx.images };
}

// ---------- Compiling ----------

function compile(compiler, source, images) {
  compiler.reset_shadow();
  for (const [path, bytes] of images) compiler.map_shadow(path, bytes);
  compiler.add_source("/main.typ", source);
  try {
    const out = compiler.compile("/main.typ", null, "pdf", 1);
    return { pdf: out && out.result, diagnostics: (out && out.diagnostics) || [] };
  } catch (err) {
    // Some failures come back as diagnostics, others are thrown.
    return { pdf: null, diagnostics: [String((err && err.message) || err)] };
  }
}

/**
 * When the whole document will not compile, find the equations that are the
 * cause by compiling each alone, and set those few as their spoken reading
 * in italics instead. A learner loses the typeset form of one equation
 * rather than the whole PDF.
 */
// One equation as learnerTypst writes it. Its body is skipped over string by
// string: an <mtext> such as "$5" becomes a Typst string holding a "$", which
// must not be taken for the end of the equation.
export const EQUATION_RE =
  /#math\.equation\(block: (true|false), alt: ("(?:[^"\\]|\\.)*")\)\[\$((?:"(?:[^"\\]|\\.)*"|[^$"\\]|\\.)*)\$\]/g;

function withoutBrokenEquations(compiler, source, images) {
  const EQ_RE = new RegExp(EQUATION_RE.source, "g");
  let broken = 0;
  const fixed = source.replace(EQ_RE, (whole, block, alt) => {
    const test = compile(compiler, `${PREAMBLE("check", "en")}\n${whole}\n`, new Map());
    if (test.pdf) return whole;
    broken += 1;
    return block === "true" ? `#align(center)[#emph(${alt})]` : `#emph(${alt})`;
  });
  return { source: fixed, broken };
}

const diagnosticText = (diagnostics) =>
  diagnostics
    .map((d) => (typeof d === "string" ? d : d && (d.message || JSON.stringify(d))))
    .filter(Boolean)
    .slice(0, 3)
    .join("; ");

/**
 * The learner PDF for a learner HTML document (a parsed Document).
 * onProgress receives short sentences for the dialog's status line.
 * Resolves to { bytes, brokenEquations }.
 */
export async function learnerPdf(doc, { onProgress = () => {} } = {}) {
  onProgress("Loading the typesetter…");
  const [compiler] = await Promise.all([loadCompiler(), loadSpeech()]);
  onProgress("Typesetting…");
  const { source, images } = learnerTypst(doc);
  let result = compile(compiler, source, images);
  let brokenEquations = 0;
  if (!result.pdf) {
    const retry = withoutBrokenEquations(compiler, source, images);
    brokenEquations = retry.broken;
    result = compile(compiler, retry.source, images);
    if (!result.pdf) throw new Error(`Typst couldn't typeset this document: ${diagnosticText(result.diagnostics) || "no details given"}.`);
  }
  return { bytes: claimPdfUa(result.pdf), brokenEquations };
}

// ---------- PDF/UA-1 identification ----------
//
// Typst tags the document fully, but this build of its web compiler has no
// switch for the PDF/UA standard, and that switch is what adds the last two
// things PDF/UA-1 asks of a file: an identification entry in its XMP
// metadata, and DisplayDocTitle, so a reader shows the title rather than the
// file name. Both are added here as an incremental update — new versions of
// the catalog and the metadata appended after the original bytes, which are
// left exactly as Typst wrote them. veraPDF checks the result in the tests.
//
// It reads Typst's output by pattern, so it depends on the layout this
// version writes (a classic xref table, an uncompressed catalog and XMP
// stream). Anything else throws rather than produce a file that claims a
// standard it may not meet.

function latin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

function objectAt(pdf, num) {
  const start = pdf.lastIndexOf(`\n${num} 0 obj`);
  if (start < 0) throw new Error(`object ${num} not found`);
  const end = pdf.indexOf("endobj", start);
  return pdf.slice(start + 1, end);
}

export function claimPdfUa(bytes) {
  const pdf = latin1(bytes);
  const fail = (why) => { throw new Error(`Couldn't finish the PDF (${why}).`); };
  const trailerAt = pdf.lastIndexOf("trailer");
  const startxrefAt = pdf.lastIndexOf("startxref");
  if (trailerAt < 0 || startxrefAt < trailerAt) fail("no trailer");
  const trailer = pdf.slice(trailerAt, startxrefAt);
  const prev = Number(pdf.slice(startxrefAt + 9).trim().split(/\s+/)[0]);
  if (!Number.isInteger(prev) || pdf.slice(prev, prev + 4) !== "xref") fail("unexpected cross-reference layout");
  const root = Number((trailer.match(/\/Root (\d+) 0 R/) || [])[1]);
  const size = Number((trailer.match(/\/Size (\d+)/) || [])[1]);
  const info = (trailer.match(/\/Info (\d+) 0 R/) || [])[1];
  const id = (trailer.match(/\/ID\s*(\[[^\]]*\])/) || [])[1];
  if (!root || !size) fail("no catalog");

  const catalogObj = objectAt(pdf, root);
  const dictStart = catalogObj.indexOf("<<");
  const dictEnd = catalogObj.lastIndexOf(">>");
  let catalog = catalogObj.slice(dictStart, dictEnd + 2);
  const metaNum = Number((catalog.match(/\/Metadata (\d+) 0 R/) || [])[1]);
  if (!metaNum) fail("no metadata");

  const metaObj = objectAt(pdf, metaNum);
  if (/\/Filter/.test(metaObj.slice(0, metaObj.indexOf("stream")))) fail("compressed metadata");
  const streamStart = metaObj.indexOf("stream") + "stream".length;
  const dataStart = streamStart + (metaObj[streamStart] === "\r" ? 2 : 1);
  let xmp = metaObj.slice(dataStart, metaObj.lastIndexOf("endstream")).replace(/\r?\n$/, "");
  if (!xmp.includes("</rdf:RDF>")) fail("unexpected metadata");
  if (!xmp.includes("pdfuaid:part")) {
    xmp = xmp.replace(
      "</rdf:RDF>",
      '<rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"><pdfuaid:part>1</pdfuaid:part></rdf:Description></rdf:RDF>'
    );
  }

  const newMeta = size;
  catalog = catalog.replace(`/Metadata ${metaNum} 0 R`, `/Metadata ${newMeta} 0 R`);
  if (/\/DisplayDocTitle/.test(catalog)) {
    catalog = catalog.replace(/\/DisplayDocTitle\s+false/, "/DisplayDocTitle true");
  } else if (/\/ViewerPreferences\s*<</.test(catalog)) {
    catalog = catalog.replace(/\/ViewerPreferences\s*<</, "/ViewerPreferences <<\n    /DisplayDocTitle true");
  } else {
    catalog = `${catalog.slice(0, -2)}  /ViewerPreferences << /DisplayDocTitle true >>\n>>`;
  }

  let tail = pdf.endsWith("\n") ? "" : "\n";
  const offsetOf = () => pdf.length + tail.length;
  const catalogOffset = offsetOf();
  tail += `${root} 0 obj\n${catalog}\nendobj\n`;
  const metaOffset = offsetOf();
  tail += `${newMeta} 0 obj\n<<\n  /Type /Metadata\n  /Subtype /XML\n  /Length ${xmp.length}\n>>\nstream\n${xmp}\nendstream\nendobj\n`;
  const xrefOffset = offsetOf();
  const entry = (offset) => `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  tail +=
    `xref\n${root} 1\n${entry(catalogOffset)}${newMeta} 1\n${entry(metaOffset)}` +
    `trailer\n<<\n  /Size ${newMeta + 1}\n  /Root ${root} 0 R\n${info ? `  /Info ${info} 0 R\n` : ""}${id ? `  /ID ${id}\n` : ""}  /Prev ${prev}\n>>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  const out = new Uint8Array(bytes.length + tail.length);
  out.set(bytes, 0);
  for (let i = 0; i < tail.length; i += 1) out[bytes.length + i] = tail.charCodeAt(i) & 0xff;
  return out;
}
