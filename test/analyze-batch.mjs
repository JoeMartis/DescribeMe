#!/usr/bin/env node
/**
 * Does description quality fall off across a batch?
 *
 *   node test/analyze-batch.mjs <project.describeme.json> [more.json ...]
 *
 * Reads exported projects (Projects → Export) and correlates every signal the
 * app already records against a slide's position in the batch. It answers one
 * question — is there a trend, and if so which signal carries it — and it is
 * deliberately noncommittal about signals that cannot bear the weight.
 *
 * On proxies and what they are worth:
 *
 *   STRONG. A transcript that stops partway, a model that changes mid-batch,
 *   a rise in truncation or malformed MathML. Each is a real difference in
 *   what the model was given or told to do, and each has a fix.
 *
 *   MODERATE. The share of slides a person edited. It is the reviewer's own
 *   verdict, recorded at the time — the closest thing here to a quality
 *   measure. It cuts both ways: a tiring reviewer may edit less, not more.
 *
 *   WEAK. Word count. A shorter description is not a worse one, and the
 *   prompt asks for brevity. Reported because a cliff in it is worth seeing,
 *   never as evidence on its own.
 *
 * Statistics: Spearman rank correlation with a permutation test, because n is
 * usually 10-25 and no parametric assumption survives that.
 */

import fs from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node test/analyze-batch.mjs <project.describeme.json> [...]");
  console.error("\nExport one from the app: folder icon → a saved project → Export.");
  process.exit(2);
}

// ---------- statistics ----------

/** Ranks with ties averaged, which is what Spearman requires. */
function rank(xs) {
  const order = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) r[order[k][1]] = shared;
    i = j + 1;
  }
  return r;
}

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i += 1) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

const spearman = (a, b) => pearson(rank(a), rank(b));

/**
 * Two-sided p by shuffling: no distributional assumption, and at n<=25 the
 * exact cost is irrelevant. Seeded so a report is reproducible.
 */
function permutationP(a, b, iterations = 20000) {
  const observed = Math.abs(spearman(a, b));
  const shuffled = b.slice();
  let seed = 0x2f6b4f;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let hits = 0;
  for (let it = 0; it < iterations; it += 1) {
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (Math.abs(spearman(a, shuffled)) >= observed - 1e-12) hits += 1;
  }
  return (hits + 1) / (iterations + 1);
}

// ---------- reading a project ----------

const words = (s) => (s || "").trim().split(/\s+/).filter(Boolean).length;
const count = (html, re) => (String(html || "").match(re) || []).length;

function load(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
  return {
    name: raw.name || file,
    file,
    slides: jobs.map((j, i) => ({
      pos: i + 1,
      name: j.name || `slide ${i + 1}`,
      state: j.state,
      described: j.state === "done" && !!j.resultHtml,
      words: words(j.resultText),
      transcript: typeof j.transcriptContext === "string" ? j.transcriptContext.length : 0,
      truncated: !!j.truncated,
      mathWarn: !!j.mathWarning,
      hasMath: count(j.resultHtml, /<math/gi) > 0,
      tables: count(j.resultHtml, /<table/gi),
      edited: !!j.edited,
      authored: !!j.authored,
      approved: !!j.approved,
      model: j.usedModel || null,
      durationMs: Number.isFinite(j.durationMs) ? j.durationMs : null,
      captureSeconds: Number.isFinite(j.captureSeconds) ? j.captureSeconds : null,
      textOnly: !!j.textOnly,
    })),
  };
}

// ---------- the report ----------

const pct = (n, d) => (d === 0 ? "—" : `${Math.round((100 * n) / d)}%`);
const clock = (s) => (s == null ? "—" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`);
const bar = (v, max, width = 18) =>
  max <= 0 ? "" : "█".repeat(Math.max(0, Math.round((v / max) * width))).padEnd(width, "·");

function trend(label, slides, pick, strength) {
  const ys = slides.map(pick);
  if (ys.every((v) => v === ys[0])) return { label, strength, verdict: "constant", rho: 0, p: 1 };
  const xs = slides.map((s) => s.pos);
  const rho = spearman(xs, ys);
  const p = permutationP(xs, ys);
  return { label, strength, rho, p, verdict: p < 0.05 ? (rho < 0 ? "FALLS" : "RISES") : "no trend" };
}

function analyze(project) {
  const all = project.slides;
  const done = all.filter((s) => s.described);

  console.log(`\n${"═".repeat(76)}`);
  console.log(`  ${project.name}`);
  console.log(`  ${project.file}`);
  console.log(`${"═".repeat(76)}\n`);

  if (done.length < 4) {
    console.log(`  Only ${done.length} described slide(s) — not enough to say anything. Skipping.\n`);
    return;
  }

  // ---- per-slide table
  const maxWords = Math.max(...done.map((s) => s.words));
  console.log("  POS  SLIDE                              WORDS            TRANSCRIPT  FLAGS");
  console.log("  " + "─".repeat(74));
  for (const s of all) {
    if (!s.described) {
      console.log(`  ${String(s.pos).padStart(3)}  ${s.name.slice(0, 32).padEnd(32)}  (${s.state})`);
      continue;
    }
    const flags = [
      s.truncated ? "CUT-OFF" : "",
      s.mathWarn ? "MATH?" : "",
      s.edited ? "edited" : "",
      s.authored ? "written" : "",
      s.textOnly ? "text-only" : "",
    ].filter(Boolean).join(" ");
    console.log(
      `  ${String(s.pos).padStart(3)}  ${s.name.slice(0, 32).padEnd(32)}  ` +
      `${String(s.words).padStart(4)} ${bar(s.words, maxWords)}  ` +
      `${s.transcript ? String(s.transcript).padStart(5) + "ch" : "    none"}  ${flags}`
    );
  }

  // ---- the transcript cliff: the mechanism most likely to be real
  console.log(`\n  ${"─".repeat(74)}`);
  console.log("  TRANSCRIPT CONTEXT");
  const withT = done.filter((s) => s.transcript > 0);
  if (withT.length === 0) {
    console.log("    No slide had transcript context. Nothing to lose, so this is not the cause —");
    console.log("    but attaching one would likely raise quality across the whole batch.");
  } else if (withT.length === done.length) {
    console.log(`    All ${done.length} slides had context. Not the cause.`);
  } else {
    const lastWith = Math.max(...withT.map((s) => s.pos));
    const firstWithout = Math.min(...done.filter((s) => s.transcript === 0).map((s) => s.pos));
    console.log(`    ${withT.length} of ${done.length} slides had context (${pct(withT.length, done.length)}).`);
    if (firstWithout > lastWith - done.length && firstWithout > 1) {
      const after = done.filter((s) => s.pos >= firstWithout);
      const afterAllMissing = after.every((s) => s.transcript === 0);
      if (afterAllMissing && after.length >= 2) {
        console.log(`\n    ⚠  CLIFF at slide ${firstWithout}: every slide from there on has none.`);
        console.log(`       Those ${after.length} slides were described with no terminology grounding,`);
        console.log(`       and the app shows nothing on the slide to say so. This is the single`);
        console.log(`       most likely cause of "it gets worse further in".`);
        const a = done.filter((s) => s.pos < firstWithout);
        console.log(`       words before ${firstWithout}: ${Math.round(a.reduce((n, s) => n + s.words, 0) / a.length)} avg` +
                    ` · from ${firstWithout}: ${Math.round(after.reduce((n, s) => n + s.words, 0) / after.length)} avg`);
        const lastCue = Math.max(...withT.map((s) => s.captureSeconds ?? -1));
        if (lastCue >= 0) console.log(`       last slide with context was captured at ${clock(lastCue)} —` +
                                      ` check whether the captions file stops near there.`);
      } else {
        console.log("    Context is missing on some slides but not in a run — looks like naming,");
        console.log("    not a transcript that ran out. Check the filenames of the slides above.");
      }
    }
  }

  // ---- confounders that would make a trend mean something else
  console.log(`\n  ${"─".repeat(74)}`);
  console.log("  CONFOUNDERS");
  const models = [...new Set(done.map((s) => s.model).filter(Boolean))];
  if (models.length > 1) {
    console.log(`    ⚠  More than one model in this batch: ${models.join(", ")}`);
    for (const m of models) {
      const g = done.filter((s) => s.model === m);
      console.log(`       ${m.padEnd(28)} ${String(g.length).padStart(3)} slides, ` +
                  `${Math.round(g.reduce((n, s) => n + s.words, 0) / g.length)} words avg, ` +
                  `positions ${Math.min(...g.map((s) => s.pos))}–${Math.max(...g.map((s) => s.pos))}`);
    }
    console.log("       A model change mid-batch explains a quality change on its own.");
  } else {
    console.log(`    One model throughout (${models[0] || "unrecorded"}). Not a confounder.`);
    console.log("    Caveat: the app records the model it ASKED for, not the one the response");
    console.log("    reported. A proxy that substituted a model would not show up here.");
  }
  const to = done.filter((s) => s.textOnly).length;
  if (to > 0) console.log(`    ${to} slide(s) are text-only (transcription, not description) — they are` +
                          ` short by design and drag any word-count trend down.`);
  const auth = done.filter((s) => s.authored).length;
  if (auth > 0) console.log(`    ${auth} slide(s) were written by hand, not by the model. Excluded from trends.`);

  // ---- trends
  console.log(`\n  ${"─".repeat(74)}`);
  console.log("  TREND AGAINST POSITION IN BATCH");
  const model = done.filter((s) => !s.authored);
  const tests = [
    trend("transcript context (chars)", model, (s) => s.transcript, "STRONG"),
    trend("cut off mid-description", model, (s) => (s.truncated ? 1 : 0), "STRONG"),
    trend("malformed equation markup", model, (s) => (s.mathWarn ? 1 : 0), "STRONG"),
    trend("a person had to edit it", model, (s) => (s.edited ? 1 : 0), "MODERATE"),
    trend("word count", model, (s) => s.words, "WEAK"),
  ];
  for (const t of tests) {
    const verdict = t.verdict === "no trend" || t.verdict === "constant"
      ? t.verdict
      : `${t.verdict}  (rho ${t.rho.toFixed(2)}, p ${t.p.toFixed(3)})`;
    console.log(`    ${t.strength.padEnd(9)} ${t.label.padEnd(28)} ${verdict}`);
  }

  // ---- halves, because a rank correlation hides a step change
  const half = Math.floor(model.length / 2);
  const first = model.slice(0, half);
  const last = model.slice(model.length - half);
  const avg = (g, f) => (g.length ? (g.reduce((n, s) => n + f(s), 0) / g.length) : 0);
  console.log(`\n    first ${half} vs last ${half}:`);
  console.log(`      words            ${avg(first, (s) => s.words).toFixed(0).padStart(5)}  →${avg(last, (s) => s.words).toFixed(0).padStart(5)}`);
  console.log(`      with transcript  ${pct(first.filter((s) => s.transcript).length, first.length).padStart(5)}  →${pct(last.filter((s) => s.transcript).length, last.length).padStart(5)}`);
  console.log(`      edited by hand   ${pct(first.filter((s) => s.edited).length, first.length).padStart(5)}  →${pct(last.filter((s) => s.edited).length, last.length).padStart(5)}`);
  console.log(`      cut off          ${pct(first.filter((s) => s.truncated).length, first.length).padStart(5)}  →${pct(last.filter((s) => s.truncated).length, last.length).padStart(5)}`);

  // ---- verdict
  console.log(`\n  ${"─".repeat(74)}`);
  console.log("  READING");
  const strong = tests.filter((t) => t.strength === "STRONG" && (t.verdict === "FALLS" || t.verdict === "RISES"));
  const moderate = tests.filter((t) => t.strength === "MODERATE" && (t.verdict === "FALLS" || t.verdict === "RISES"));
  const wordTrend = tests.find((t) => t.label === "word count");
  // A confounder outranks the trend tests. Two models in one batch is a
  // sufficient explanation on its own, and reporting "no signal" underneath
  // a warning that the model changed halfway would be the wrong reading of
  // the same page.
  if (models.length > 1) {
    console.log("    The model changed partway through this batch, which explains a quality");
    console.log("    change by itself — nothing further can be read from position here.");
    console.log("    Re-run the whole batch on one model before drawing any conclusion.");
  } else if (strong.length) {
    console.log("    Something mechanical is going on. These moved with position:");
    for (const t of strong) console.log(`      • ${t.label} ${t.verdict.toLowerCase()}`);
    console.log("    Each has a cause you can fix. Start with the transcript section above.");
  } else if (moderate.length) {
    console.log("    No mechanical cause found, but the reviewer edited later slides more often.");
    console.log("    That is either the content getting harder (decks build toward dense figures)");
    console.log("    or the reviewer getting sharper and less patient. The app cannot tell those");
    console.log("    apart — shuffling the rail order on the next batch can.");
  } else {
    console.log("    No signal moves with position. On this batch the descriptions do not");
    console.log("    measurably degrade, which points at ordering (later slides are harder) or");
    console.log("    at review fatigue rather than at the tool.");
    if (wordTrend && (wordTrend.verdict === "FALLS" || wordTrend.verdict === "RISES")) {
      console.log(`    Word count does move (${wordTrend.verdict.toLowerCase()}), but on its own that is not`);
      console.log("    quality: the prompt asks for brevity, and a simpler slide earns fewer words.");
    }
    console.log("    The decisive test: describe a deck in reverse rail order. If the complaints");
    console.log("    follow the reviewing order rather than the slides, it is not the model.");
  }
  console.log();
}

for (const f of files) {
  try {
    analyze(load(f));
  } catch (err) {
    console.error(`\n  ${f}: could not read — ${err.message}\n`);
  }
}
