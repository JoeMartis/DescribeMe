# Tests

Browser regression suites. They drive a real headless Chromium against a real
HTTP origin, because that is the only place the app's behaviour is real: it
uses ES modules, IndexedDB, downloads and a Content Security Policy, and none
of those behave the same over `file://`.

**No API key is needed and no request ever leaves the machine.** Every suite
that exercises a describe run intercepts `**/v1/messages` with
`page.route(...)` and answers it locally. Several suites assert on the *number*
of intercepted calls, so a suite that accidentally reached the network would
fail rather than quietly bill someone.

## Running them

```sh
cd test
npm install            # Playwright, once
npx playwright install chromium

node run.mjs           # every suite
node run.mjs regress8   # just one
```

`run.mjs` starts its own static server on a port the OS picks, passes the URL
down as `DESCRIBEME_URL`, runs each suite as a child process, and exits
non-zero if any of them fail. Starting a server by hand is the step everyone
forgets, and forgetting it produces a run that fails for a reason nothing on
screen explains — so the runner owns it.

To run one file directly against a server you started yourself, serve the repo
root on `127.0.0.1:8110` and `node regress8.mjs`. Set `DESCRIBEME_URL` for any
other address.

Suites write downloads and screenshots to `test/.out/`, which is gitignored.

## What each suite covers

| Suite | Covers |
| --- | --- |
| `smoke.mjs` | The page loads clean; the three dialogs open and close without console errors, page errors or CSP violations |
| `regress.mjs` | Video capture, crop, duplicate-timestamp refusal, transcript attachment, the export zip |
| `regress2.mjs` | Projects: save, open, export, import, and the sanitising an imported project goes through |
| `regress3.mjs` | Image preparation — resize, re-encode, the 5 MB payload cap, undecodable files |
| `regress4.mjs` | Describe runs: concurrency, retries, cancel, refusals, per-slide actions |
| `regress5.mjs` | Export heading levels, the relative subheading shift, h6 clamping, visual counts |
| `regress6.mjs` | The Help link — three placements, target/rel, an accessible name that says it leaves the page |
| `regress7.mjs` | Jump-to-time in the video dialog: the three formats, rejections, Escape |
| `regress8.mjs` | Write description — the hand-authored path, and that it makes no API call |
| `regress9.mjs` | The order of the parts inside one exported description block |

## Writing one

`fixtures.mjs` has the shared pieces: `launch()` (a browser that collects
console errors, page errors and CSP violations into `problems`, and accepts
the app's confirm dialogs), `openWorkspace()`, `addFiles()`, `outDir()`, and
generators for test media — `makeImage()` draws a PNG or JPEG on a canvas,
`makeVideo()` records a WebM whose frames show the elapsed second, `srt()`
builds captions. Nothing is checked in as a binary fixture; it is all
synthesised at run time.

The suites use a plain `check(name, ok, note)` that prints `PASS`/`FAIL` and
tallies, rather than a test framework — one less dependency, and the output
reads the same whether you run one suite or all of them. Pass the failing
value as `note`: on a red run, that string is usually the whole diagnosis.
