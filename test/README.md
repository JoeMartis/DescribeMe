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

### veraPDF, for the learner PDF

`regress18` checks the learner PDF's structure itself, and also runs
[veraPDF](https://verapdf.org) — the reference PDF/UA checker — when
`VERAPDF_LIB` points at a folder of its jars. veraPDF is Java, so it is not a
dependency of this repo; without it, that one check prints `SKIP`. One way to
get the jars, with Maven:

```sh
mkdir verapdf && cd verapdf
cat > pom.xml <<'EOF'
<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>
<groupId>local</groupId><artifactId>verapdf</artifactId><version>1</version>
<dependencies><dependency><groupId>org.verapdf.apps</groupId><artifactId>greenfield-apps</artifactId><version>1.28.2</version></dependency></dependencies>
</project>
EOF
mvn -q dependency:copy-dependencies -DoutputDirectory=lib
VERAPDF_LIB="$PWD/lib" node ../test/run.mjs regress18
```

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
| `regress10.mjs` | Text & math mode sends a transcription prompt, read off the wire — not a description prompt with a rebuttal stapled on |
| `regress11.mjs` | Refine choices stay on the slide they were pressed on, and do not leak into the next slide's request |
| `regress12.mjs` | The transcript cliff — captions that stop before the recording does, and every place that has to say so |
| `regress13.mjs` | Cost: the `usage` block the API returns, cache read/write rates, Parley's cost header, and the ledger surviving undo |
| `regress14.mjs` | The rail's Save button and what "Saved" means, the New batch warning, and filenames shown in full in the rail and the Projects dialog |
| `regress15.mjs` | The video team's export names — position-then-time and time-then-position — pairing with their transcript in either arrival order, the export's timestamp, and the optional sort by slide position with its undo |
| `regress16.mjs` | The gap between exported visuals — a heading-only slide no longer runs into the next visual's title, measured in a plain page the way it renders after pasting |
| `regress17.mjs` | No "read as" line after equations — neither prompt asks for one, and a description that still carries one loses it as a fresh result, an imported project, and a project opened from the store, before it can reach an export |
| `regress18.mjs` | Learner downloads, opened with their `?learner-downloads` flag — and hidden without it, even with approved visuals. The HTML: a complete page with its own CSP, h1 then one h2 per visual, images built in, MathML intact, and nothing requested when opened from disk. The PDF: tagged, every equation a Formula with a spoken alt text (Delta, not triangle; H sub 2 O), slide images as artifacts, PDF/UA-1 identification, nothing fetched off-site to make it, and veraPDF's verdict when available |
| `regress19.mjs` | No batch limit — 75 slides added in two drops, described with never more than three requests at once, saved and reopened, exported as a project file and imported back, and exported as a 75-visual zip |
| `regress20.mjs` | Shared project folders, behind `?learner-downloads`. The browser's private folder (OPFS) stands in for the shared one, and a teammate is simulated by changing files in it. Choosing the folder; a browser project copied in as a lecture with no image data in its `project.json` and each image stored once; opening it with slides, approvals, timestamps and originals intact; saving as you work, and removing images nothing uses; a teammate's save left alone, with the reason shown and Save asking before replacing it; the in-use note; a new lecture and a refused name clash; a hostile lecture kept inside `images/` and sanitized; a reload rejoining the lecture |

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
