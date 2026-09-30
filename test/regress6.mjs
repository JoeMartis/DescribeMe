// The Help link: present in three places, correct target/rel, an accessible
// name that says it leaves the page, no CSP violation, and it does not push
// the header onto a second line.
import { launch, openWorkspace, APP_URL } from "./fixtures.mjs";

const MANUAL = "https://claude.ai/code/artifact/cd59ab2f-215c-41a9-926d-45d878cb7481";
const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const { b, ctx, page, problems } = await launch();
// Stub the destination: the sandbox has no route to claude.ai, and the test
// is about what the link points at, not about the manual loading.
await ctx.route("https://claude.ai/**", (r) =>
  r.fulfill({ status: 200, contentType: "text/html", body: "<title>DescribeMe Manual</title>ok" })
);

await page.goto(APP_URL, { waitUntil: "load" });

// ---- onboarding link (before skipping past it)
const onboard = await page.evaluate((url) => {
  const a = [...document.querySelectorAll("#onboarding a")].find((x) => x.href === url);
  return a ? { href: a.href, target: a.target, rel: a.rel, text: a.textContent.trim() } : null;
}, MANUAL);
check("L1  onboarding offers the manual", !!onboard && onboard.target === "_blank" && /noopener/.test(onboard.rel), JSON.stringify(onboard));
check("L1  its name says it opens a new tab", !!onboard && /opens in a new tab/i.test(onboard.text), onboard && onboard.text);

await page.click("#onboardSkip");

// ---- header link
const header = await page.evaluate((url) => {
  const a = document.getElementById("helpLink");
  if (!a) return null;
  const tools = [...document.querySelectorAll(".header-tools > *")];
  const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
  const centres = tools.map(mid);
  return {
    href: a.href, matches: a.href === url, target: a.target, rel: a.rel,
    name: (a.textContent || "").trim(),
    isAnchor: a.tagName === "A",
    spread: Math.max(...centres) - Math.min(...centres),
    toolCount: tools.length,
    headerOverflows: document.querySelector(".app-header").scrollHeight > document.querySelector(".app-header").clientHeight + 1,
  };
}, MANUAL);
check("L2  the header carries a real link to the manual", !!header && header.isAnchor && header.matches && header.target === "_blank" && /noopener/.test(header.rel), JSON.stringify(header && { t: header.target, r: header.rel, m: header.matches }));
check("L2  it has an accessible name naming the new tab", !!header && /manual/i.test(header.name) && /opens in a new tab/i.test(header.name), header && header.name);
check("L2  the header tools stay on one line at 1280px", !!header && header.spread < 8 && !header.headerOverflows, header && `spread=${header.spread.toFixed(1)} tools=${header.toolCount}`);

// ---- at a narrow-desktop width too
await page.setViewportSize({ width: 1100, height: 800 });
await page.waitForTimeout(150);
const narrow = await page.evaluate(() => {
  const h = document.querySelector(".app-header");
  return { overflows: h.scrollHeight > h.clientHeight + 1, height: h.getBoundingClientRect().height };
});
check("L3  the header still does not overflow at 1100px", !narrow.overflows, `height=${narrow.height.toFixed(0)}`);
await page.setViewportSize({ width: 1280, height: 800 });

// ---- settings link
await page.click("#settingsChip");
const inSettings = await page.evaluate((url) => {
  const a = [...document.querySelectorAll("#settingsDialog a")].find((x) => x.href === url);
  return a ? { target: a.target, rel: a.rel, text: a.textContent.trim() } : null;
}, MANUAL);
check("L4  settings offers the manual too", !!inSettings && inSettings.target === "_blank" && /noopener/.test(inSettings.rel), JSON.stringify(inSettings));
await page.click("#settingsClose");

// ---- clicking it opens the manual in a new tab, and the CSP does not block it
const popupPromise = ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null);
await page.click("#helpLink");
const popup = await popupPromise;
let popupUrl = null;
if (popup) {
  await popup.waitForLoadState("load").catch(() => {});
  popupUrl = popup.url();
  await popup.close();
}
check("L5  clicking opens the manual in a new tab", popupUrl === MANUAL, String(popupUrl));
check("L5  the app itself did not navigate away", page.url().endsWith("/index.html"), page.url());

const csp = problems.filter((m) => /CSP:/.test(m));
check("L5  no CSP violation from the link", csp.length === 0, csp.join(" | "));
check("L   no page errors", problems.filter((m) => !/404/.test(m)).length === 0, problems.join(" | "));

await b.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
