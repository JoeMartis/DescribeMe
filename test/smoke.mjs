// Baseline: does the app load clean, and do the three dialogs open/close
// without console errors, page errors, or CSP violations?
import { chromium } from "playwright";
import { APP_URL } from "./fixtures.mjs";

const URL = APP_URL;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const problems = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") problems.push(`[console.${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));
await page.addInitScript(() => {
  document.addEventListener("securitypolicyviolation", (e) => {
    console.error(`CSP: ${e.violatedDirective} blocked ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}`);
  });
});

await page.goto(URL, { waitUntil: "load" });
const state0 = await page.evaluate(() => ({
  onboardingHidden: document.getElementById("onboarding").hidden,
  appHidden: document.getElementById("app").hidden,
  version: window.APP_VERSION,
}));
console.log("after load:", JSON.stringify(state0));

// Skip onboarding → workspace
await page.click("#onboardSkip");
const state1 = await page.evaluate(() => ({
  onboardingHidden: document.getElementById("onboarding").hidden,
  appHidden: document.getElementById("app").hidden,
  cogAlert: document.getElementById("settingsChip").classList.contains("btn-alert"),
  cogLabel: document.getElementById("settingsChip").getAttribute("aria-label"),
}));
console.log("after skip:", JSON.stringify(state1));

// Each dialog opens and closes
for (const [btn, dlg, close] of [
  ["#settingsChip", "#settingsDialog", "#settingsClose"],
  ["#projectsBtn", "#projectsDialog", "#projectsClose"],
  ["#videoBtn", "#videoDialog", "#videoClose"],
]) {
  await page.click(btn);
  const open = await page.$eval(dlg, (d) => d.open);
  await page.click(close);
  const closed = await page.$eval(dlg, (d) => !d.open);
  console.log(`${dlg}: open=${open} closed=${closed}`);
}

// Duplicate ids anywhere in the live DOM (templates are inert, so also count inside them)
const dupes = await page.evaluate(() => {
  const seen = new Map();
  const all = [...document.querySelectorAll("[id]")];
  for (const t of document.querySelectorAll("template")) all.push(...t.content.querySelectorAll("[id]"));
  for (const el of all) seen.set(el.id, (seen.get(el.id) || 0) + 1);
  return [...seen].filter(([, n]) => n > 1);
});
console.log("duplicate ids:", JSON.stringify(dupes));

// [hidden] must beat any display rule
const hiddenBeatsDisplay = await page.evaluate(() => {
  const el = document.createElement("div");
  el.className = "app"; // .app is display:grid/flex in style.css
  el.hidden = true;
  document.body.appendChild(el);
  const d = getComputedStyle(el).display;
  el.remove();
  return d === "none";
});
console.log("[hidden] beats .app display rule:", hiddenBeatsDisplay);

console.log("\nPROBLEMS:", problems.length ? "\n" + problems.join("\n") : "none");
await b.close();
