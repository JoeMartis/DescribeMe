// What a request actually cost. The app used to price every slide from a word
// count at the plain input rate and never look at the `usage` block coming
// back — which is wrong wherever prompt caching is in play, and under MIT
// Parley it always is: Parley inserts cache breakpoints by default, so cached
// tokens are billed at a tenth (reads) or double (1-hour writes) the input
// rate the estimate assumed.
import { launch, makeImage, openWorkspace, addFiles } from "./fixtures.mjs";

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  — " + note : ""}`); };

const { b, page, problems } = await launch();

// The mock's usage block, swapped per case. null means "send no usage at all",
// which is what an older proxy or an unexpected response shape looks like.
let usage = null;
let extraHeaders = {};
let replyText = "<h2>Title</h2><p>Body text here.</p>";

await page.route("**/v1/messages", async (route) => {
  const body = JSON.parse(route.request().postData());
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*", ...extraHeaders },
    body: JSON.stringify({
      stop_reason: "end_turn",
      model: body.model,
      content: [{ type: "text", text: replyText }],
      ...(usage ? { usage } : {}),
    }),
  });
});

await openWorkspace(page);

const setKey = (key) => page.evaluate((k) => {
  const el = document.getElementById("apiKey");
  el.value = k;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, key);

const chip = () => page.evaluate(() => ({
  label: document.getElementById("costChipLabel").textContent,
  value: document.getElementById("costChipValue").textContent,
  detail: document.getElementById("costDetail").hidden ? null : document.getElementById("costDetail").textContent,
  hintLead: document.getElementById("costHintLead").textContent,
}));

// ---------- U0: the pre-flight estimate knows which endpoint it is estimating
// Parley caches whether or not the app asks; a direct Anthropic key caches
// nothing, because the Messages API only caches where cache_control says to.
// The two cannot cost the same, and an estimate that ignored the difference
// would sit visibly apart from the measured total that replaces it.
await page.evaluate(() => { document.getElementById("model").value = "claude-sonnet-5"; });
await setKey("sk-test-parley");
const parleyEstimate = (await chip()).value;
await setKey("sk-ant-direct");
const anthropicEstimate = (await chip()).value;
check("U0  the estimate is still an estimate before anything is sent",
  (await chip()).label === "Est. per slide", (await chip()).label);
check("U0  a Parley key and an Anthropic key do not get the same estimate",
  parleyEstimate !== anthropicEstimate, `parley ${parleyEstimate} / anthropic ${anthropicEstimate}`);
check("U0  the hint says these are estimates",
  (await chip()).hintLead === "Estimates only", (await chip()).hintLead);

await setKey("sk-test-parley");

const png = await makeImage(page, { label: "s" });
await addFiles(page, [
  { name: "a.png", mimeType: "image/png", buffer: png },
  { name: "b.png", mimeType: "image/png", buffer: png },
]);
await page.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length === 2);

const select = async (i) => {
  await page.evaluate((n) => [...document.querySelectorAll("#railList .rail-row")][n].click(), i);
  await page.waitForTimeout(250);
};
const describeSelected = async () => {
  await page.click("#detailPane .js-pending-primary");
  await page.waitForTimeout(1200);
};
const meta = () => page.textContent("#detailPane .js-slide-meta");

// ---------- U1: the cost on screen is the one the API reported
// Sonnet 5 at $2/MTok in, $10/MTok out. With a 1-hour cache write at 2x and a
// read at 0.1x:
//   100 input    ->  100 * 2e-6            = $0.0002
//   1000 read    -> 1000 * 2e-6 * 0.1      = $0.0002
//   500 written  ->  500 * 2e-6 * 2        = $0.0020
//   200 output   ->  200 * 10e-6           = $0.0020
//                                            -------
//                                            $0.0044
usage = {
  input_tokens: 100,
  output_tokens: 200,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 500,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 },
};
await select(0);
await describeSelected();
check("U1  the slide shows the measured cost, priced off the usage block",
  /\$0\.0044/.test(await meta()), await meta());

let c = await chip();
check("U1  the chip stops calling it an estimate", c.label === "Billed this session", c.label);
check("U1  and shows the same total", c.value === "$0.0044", c.value);
check("U1  the hint stops saying 'estimates only'", c.hintLead === "Measured, not estimated", c.hintLead);

// ---------- U2: the token counts are reported, not just the money
check("U2  the detail line reports input and output tokens",
  /100 input, 200 output tokens/.test(c.detail), c.detail);
check("U2  and what the cache did",
  /1,000 tokens read from cache, 500 written/.test(c.detail), c.detail);
check("U2  the remaining slide is still an estimate, and says so",
  /1 slide not yet described — roughly \$/.test(c.detail), c.detail);

// ---------- U3: a 5-minute write is not priced as a 1-hour one
// Same numbers, but the write is in the 5m bucket: 500 * 2e-6 * 1.25 = $0.00125,
// so the slide costs $0.00365 rather than $0.0044.
usage = {
  input_tokens: 100,
  output_tokens: 200,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 500,
  cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
};
await select(1);
await describeSelected();
check("U3  a 5-minute cache write is charged at 1.25x, not 2x",
  /\$0\.003[67]/.test(await meta()), await meta());

// ---------- U4: the ledger adds up and does not double-count
c = await chip();
check("U4  the session total is the sum of both requests",
  /^\$0\.00(80|81)$/.test(c.value), c.value);
check("U4  and counts two requests", /^2 requests/.test(c.detail), c.detail);
check("U4  with nothing left to estimate", !/not yet described/.test(c.detail), c.detail);

// ---------- U5: undo puts back the old description's cost, but not the money
// Refining spends again. Undoing restores the earlier text and the price of
// the request that wrote it — but the bill does not shrink, because the
// refine request was still sent and still billed.
usage = {
  input_tokens: 100,
  output_tokens: 1000, // $0.0100 of output alone — unmistakable
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
replyText = "<h2>Refined</h2><p>A longer, refined description.</p>";
await select(1);
await page.click("#detailPane .js-refine-detail");
await page.waitForTimeout(1400);
check("U5  the refined slide shows the refine request's cost",
  /\$0\.0102/.test(await meta()), await meta());
const afterRefine = (await chip()).value;

await page.click("#detailPane .js-undo");
await page.waitForTimeout(400);
check("U5  undo puts back the earlier description's cost",
  /\$0\.003[67]/.test(await meta()), await meta());
c = await chip();
check("U5  but the session total does not go down — the request was still billed",
  c.value === afterRefine, `${c.value} vs ${afterRefine}`);
check("U5  and still counts three requests", /^3 requests/.test(c.detail), c.detail);

// ---------- U6: Parley's own cost header wins over our arithmetic
// It is the authoritative number where it arrives. It is also a custom header
// on a cross-origin response, so the browser only hands it over when Parley
// lists it in Access-Control-Expose-Headers — hence the fallback everything
// above exercises. Here it is exposed, and it must override the computed
// figure even though the usage block would price this request at $0.0102.
extraHeaders = {
  "x-parley-v1-cost": "0.0250",
  "access-control-expose-headers": "x-parley-v1-cost",
};
const beforeHeaderCase = (await chip()).value;
await select(0);
await page.click("#detailPane .js-refine-detail");
await page.waitForTimeout(1400);
const headerMeta = await meta();
const headerRead = /\$0\.0250/.test(headerMeta);
check("U6  when Parley reports the cost itself, that number is the one shown",
  headerRead, headerMeta);
if (headerRead) {
  c = await chip();
  const expected = `$${(parseFloat(beforeHeaderCase.slice(1)) + 0.025).toFixed(4)}`;
  check("U6  and it is what the session total goes up by", c.value === expected,
    `${beforeHeaderCase} + $0.0250 = ${c.value}, expected ${expected}`);
} else {
  // Not a pass — if this ever fires, the header branch is untested and the
  // message says so rather than the suite quietly covering one path less.
  check("U6  and it is what the session total goes up by", false,
    "header was not readable from the page, so the override never ran");
}
extraHeaders = {};

// ---------- U7: writes with no reads are called out
// This is the shape that costs money for nothing: a breakpoint landing after
// content that never repeats, so the write premium is paid every time and
// never earned back. It is invisible in the dollar total alone.
const { b: b2, page: p2, problems: problems2 } = await launch();
let usage2 = {
  input_tokens: 100,
  output_tokens: 100,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 1500,
};
await p2.route("**/v1/messages", async (route) => {
  const body = JSON.parse(route.request().postData());
  await route.fulfill({
    status: 200, contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({
      stop_reason: "end_turn", model: body.model, usage: usage2,
      content: [{ type: "text", text: "<h2>T</h2><p>B.</p>" }],
    }),
  });
});
await openWorkspace(p2);
await p2.evaluate(() => {
  const k = document.getElementById("apiKey");
  k.value = "sk-test-parley"; k.dispatchEvent(new Event("input", { bubbles: true }));
  document.getElementById("model").value = "claude-sonnet-5";
});
await addFiles(p2, [
  { name: "a.png", mimeType: "image/png", buffer: png },
  { name: "b.png", mimeType: "image/png", buffer: png },
]);
await p2.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length === 2);
await p2.click("#describeBtn");
await p2.waitForTimeout(2500);
const detail2 = await p2.evaluate(() => document.getElementById("costDetail").textContent);
check("U7  a batch that only ever writes to cache is called out, not left in the numbers",
  /nothing has been read back yet/.test(detail2), detail2);

// ---------- U8: no usage block means no cost, not a fabricated one
usage2 = null;
const { b: b3, page: p3, problems: problems3 } = await launch();
await p3.route("**/v1/messages", async (route) => {
  const body = JSON.parse(route.request().postData());
  await route.fulfill({
    status: 200, contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({
      stop_reason: "end_turn", model: body.model,
      content: [{ type: "text", text: "<h2>T</h2><p>B.</p>" }],
    }),
  });
});
await openWorkspace(p3);
await p3.evaluate(() => {
  const k = document.getElementById("apiKey");
  k.value = "sk-test-parley"; k.dispatchEvent(new Event("input", { bubbles: true }));
});
await addFiles(p3, [{ name: "a.png", mimeType: "image/png", buffer: png }]);
await p3.waitForFunction(() => document.querySelectorAll("#railList .rail-row").length === 1);
await p3.evaluate(() => [...document.querySelectorAll("#railList .rail-row")][0].click());
await p3.waitForTimeout(200);
await p3.click("#detailPane .js-pending-primary");
await p3.waitForTimeout(1400);
const meta3 = await p3.textContent("#detailPane .js-slide-meta");
check("U8  a response with no usage block shows no cost rather than a guess",
  !/\$/.test(meta3), meta3);
const chip3 = await p3.evaluate(() => ({
  label: document.getElementById("costChipLabel").textContent,
  lead: document.getElementById("costHintLead").textContent,
}));
check("U8  and the chip stays on the estimate wording",
  /^Est\./.test(chip3.label) && chip3.lead === "Estimates only", `${chip3.label} / ${chip3.lead}`);
check("U8  the description itself still arrived",
  /Body|B\./.test(await p3.textContent("#detailPane")), "");

check("Z  no console errors or CSP violations",
  problems.length === 0 && problems2.length === 0 && problems3.length === 0,
  [...problems, ...problems2, ...problems3].join(" | "));

await b.close();
await b2.close();
await b3.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
