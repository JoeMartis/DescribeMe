# DescribeMe

A tiny, standalone web app that generates screen-reader-friendly extended
descriptions of STEM lecture slides using Claude. Upload one or more slide
images, click **Describe all**, and get back semantic HTML (with MathML for
equations) ready to embed next to each slide.

The whole thing is static HTML/CSS/JS — no build step, no backend. It calls
the MIT Parley API (an Anthropic-API-compatible proxy) directly from your
browser using an API key you supply, and is designed to be hosted for free on
GitHub Pages.

## Using it

**First run.** A one-time setup screen asks for your MIT Parley API key, how
long to remember it (this tab only, this device, or not at all — the
default), and a starting **Model**, listed cheapest to most expensive with a
live per-slide cost estimate next to each:

- **Claude Haiku 4.5** — fastest and cheapest; fine for simple slides.
- **Claude Sonnet 5** — sharper on dense equations and smaller text; the
  default.
- **Claude Opus 5** — most thorough; best for crowded, multi-part figures.

The estimate is computed from per-model rates recorded in `app.js` (taken
from Parley's published pricing — update them there if pricing changes),
for a typical image and description length. It's a rough estimate, **not a
budgeting tool**. All of this (plus the **Description verbosity**
slider — Concise / Standard / Detailed, and a collapsible **System prompt
used** view showing the exact prompt text for the current verbosity) stays
reachable afterward from the gear icon in the header, which opens the same
fields in a settings dialog.

**The workspace** is two panes: a **Slides** rail on the left, and the
selected slide's image plus its description on the right.

1. Drop slide images anywhere in the workspace (or use **Add** in the rail) —
   PNG, JPEG, WebP, or GIF, up to 25 per batch. Large images are resized
   (and oversized files re-encoded) in your browser before upload, so
   original file size barely matters — anything up to 50 MB is accepted.
2. Click **Describe all**. A progress card tracks the batch; you can **Stop**
   mid-run. Each rail row shows that slide's status, and clicking one selects
   it in the detail pane. The arrow buttons beside each row (or dragging a
   row) reorder the batch — review order, <kbd>←</kbd>/<kbd>→</kbd>
   navigation, and the export all follow the rail's order.
3. For the selected slide, once described: read the rendered description,
   check **HTML source** for the raw markup, or use **Copy HTML** / **Copy
   text**.
4. **Edit** turns the description directly editable in place, with a
   formatting toolbar (bold, italic, heading level, lists) that applies to
   the selected text. For structural fixes beyond what the toolbar covers —
   a list that should be a table, a `<p>` that should be a `<figcaption>` —
   open **HTML source** and use **Edit source** to change the markup
   directly. Either way, saving runs the result back through the
   same sanitizer before it's kept, and pushes the previous version onto the
   undo stack. If a description needs more work instead, **More detail**,
   **Shorter**, **Text only** (for title or section-divider slides that are
   just on-screen text — skips the narrative description and returns a plain
   transcription instead), or **Redo with a stronger model** re-run just that
   slide with an adjusted prompt — the previous version is kept so **Undo
   revision** can restore it.
5. **Approve & next** (or press <kbd>A</kbd>) marks the slide ready for
   export and jumps to the next unapproved one; <kbd>←</kbd>/<kbd>→</kbd>
   move between slides at any time. Only approved slides go into the export.
6. Failed slides show the error inline with a **Retry** button; any slide can
   be removed from the batch from its detail pane, and **New batch** in the
   rail clears all of them to start over (always behind a confirm — the
   warning is sharper when descriptions would be lost).
7. **Export as .zip** combines every approved slide, in rail order, into a
   single `description.html` — one `<img src="/static/…">` (using each
   slide's original filename) followed by its description, ready to paste
   whole into a Studio HTML component under the video(s) it describes. The
   zip also includes each slide's original image file, to upload into
   Studio's Files & Uploads under that same name so the `/static/` reference
   resolves.

Nothing is uploaded to any server other than the MIT Parley endpoint. There is
no backend for this site — GitHub Pages only serves the static files.

**Projects.** The folder icon in the header saves the current batch — slides,
descriptions, edits, approvals, and the batch name — to your browser's
IndexedDB, and lists every saved project so you can reopen one later, exactly
as you left it. Like everything else here it's client-side only: a saved
project lives in the browser it was saved in, and clearing the site's
browsing data deletes it. To hand a batch to someone else (or move it to
another machine), **Export** any saved project as a `.describeme.json` file
and use **Import a project file** on the other side — the file carries the
slides and descriptions, never your API key. Imported files are treated as
untrusted: every description in one is re-run through the same sanitizer as
model output before it's stored.

**Auto-save.** Separately from named projects, the current batch is quietly
autosaved to IndexedDB a moment after every change (and when the tab is
hidden or closed), and restored on the next load — an accidental refresh
mid-review no longer costs anything. **New batch** clears the autosave along
with the batch. Named projects are still the way to keep more than one batch
around, or to export one for someone else; the autosave only ever holds the
latest state of the current one, in this browser.

## Making the API calls efficient

A few things keep batches fast and cheap:

- **Client-side image downscaling.** Images are resized in-browser (via
  `<canvas>`) to at most 1568px on the long edge before upload — Claude
  downsamples larger images internally anyway, so sending them at full
  resolution only adds tokens and upload time without improving the
  description. Small images are sent unmodified — unless the file's payload
  would exceed the API's ~5 MB per-image cap (say, a many-frame GIF), in
  which case it's re-encoded as JPEG at the same dimensions instead of
  being rejected.
- **Bounded concurrency.** Slides in a batch are described in parallel, up to
  3 at a time, instead of either running one at a time (slow) or firing
  everything at once (likely to hit rate limits and waste retries).
- **Automatic retry with backoff.** Rate-limit (429) and server (5xx)
  responses, and transient network failures, are retried with exponential
  backoff (respecting the API's `retry-after` header when present) instead of
  failing the whole slide on the first hiccup.
- **A single request per slide.** Each image gets exactly one Messages API
  call — no unnecessary round trips.

## Accessibility

The app itself is built to be usable with a screen reader and keyboard-only,
not just to produce accessible output:

- **Keyboard-operable upload.** The upload control is a real, natively
  focusable `<input type="file">` with an accessible name and description —
  not a decorative element with a synthetic click handler bolted on, and not
  a redundant second tab stop alongside one. Drag-and-drop is available as an
  additional, mouse-only convenience.
- **Live status announcements.** The overall batch status (`role="status"`)
  and any error (`role="alert"`) are in `aria-live` regions, so progress and
  problems are announced without the user needing to hunt for them. When a
  batch finishes with failures, the specific filenames are named — not just a
  count — so there's no need to manually scan the list to find out which
  slides need a retry.
- **Keyboard slide navigation.** <kbd>←</kbd>/<kbd>→</kbd> move between
  slides and <kbd>A</kbd> approves the selected one (ignored while focus is
  in a field or the settings dialog is open), so reviewing a batch doesn't
  require pointing at a rail row for every slide. Rail rows are real
  `<button>`s with `aria-current` marking the selected one, not `<div>`s with
  a synthetic click handler.
- **Per-slide regions.** Each result is `role="region"` with an accessible
  name from its filename, so navigating by landmark (a common screen-reader
  technique) gives clear "which slide is this" context — independent of
  whatever heading levels (`<h2>`/`<h3>`) the generated description itself
  uses internally.
- **Visible focus, semantic controls.** Keyboard focus always gets a
  visible ring (via `:focus-visible`, so mouse clicks don't paint stray
  outlines); settings use a native `<dialog>` (built-in focus trapping and Escape-to-
  close), grouped radio options use `<fieldset>`/`<legend>`, and the "HTML
  source" view is a native `<details>`/`<summary>` rather than a
  custom-built, keyboard-reimplemented
  toggle.

The **generated descriptions** are the other half of this: the prompt asks
for semantic headings, list grouping, MathML with a plain-language reading
alongside every equation, `<figure>`/`<figcaption>` for diagrams, real
`<table>` markup with `<th>` for data, and color/emphasis described by what
it means rather than how it looks — see `app.js`'s `SYSTEM_PROMPT` for the
exact instructions. Rendering relies on the browser's native MathML support
(shipped in current Chrome, Firefox, and Safari).

## Hosting on GitHub Pages

1. Push this repository to GitHub.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to `Deploy from a branch`,
   pick the branch (e.g. `main`) and the `/ (root)` folder.
4. Save. GitHub will publish the site at
   `https://<your-username>.github.io/<repo-name>/`.

No secrets or environment variables are needed at deploy time — the API key
is entered by whoever uses the page, in their own browser.

## About MIT Parley

MIT Parley proxies requests to the Anthropic API. This app talks to it at a
fixed base URL (`https://parley.api.mit.edu`) and sends requests to
`/v1/messages` exactly as the Anthropic SDK would, using the key you enter
during setup or in **Settings**. API keys are issued at
[platform.parley.mit.edu/my-keys](https://platform.parley.mit.edu/my-keys).

## Security notes

- Your API key is only ever sent as an `x-api-key` header on requests to MIT
  Parley — it is never sent anywhere else, and this site has no server
  component to intercept or log it.
- By default the key is kept only in page memory and is gone as soon as you
  reload or close the tab. The "remember" options use your browser's
  `sessionStorage`/`localStorage`, entirely client-side.
- This calls MIT Parley directly from a browser, which relies on Parley
  allowing cross-origin (CORS) requests from this page's origin — Parley,
  not this app, controls whether that's permitted. If requests fail with a
  network error (not an HTTP error from the API), check your browser's
  DevTools console for a CORS message and, if you see one, ask MIT IT to
  allow browser access from this page's origin.
- Anyone who can read your page's network traffic (e.g. via browser
  devtools) can see your API key, the same as with any client-side API key
  usage — don't use a key with broader scope than you're comfortable
  exposing in your own browser.
- Model output is sanitized before being rendered — this matters because the
  description text is ultimately derived from an uploaded image, and text
  hidden in a slide (e.g. from a shared or third-party deck) could act as an
  indirect prompt injection attempting to steer the model into emitting
  unwanted markup. The sanitizer uses allowlists rather than blocklists
  where it matters most: `href`/`src` only accept `https:`, `mailto:`, or
  (for images) `data:image/` — anything else, including `javascript:` and
  `data:text/html`, is stripped; `style` and `target` attributes and event
  handler (`on*`) attributes are stripped outright; `<script>`, `<iframe>`,
  `<object>`, `<embed>`, `<style>`, `<form>`, `<meta>`, `<base>`, and `<link>`
  tags are removed everywhere, including inside SVG/MathML content (where a
  naive check can miss them — foreign-content elements keep their original
  tag-name casing instead of the uppercase HTML elements normally get).
  `<template>` and `<svg>` are removed too: a `<template>`'s content lives in
  a separate, detached DocumentFragment that a naive tree walk never
  descends into, and SVG's declarative animation elements (`<animate>`,
  `<set>`) can rewrite an attribute like `href` *after* it was already
  checked, once the sanitized fragment is live in the page — removing the
  whole subtree closes both without needing to enumerate every SVG
  sub-feature individually. An `<img>` that ends up with no valid `src` after
  that filtering is dropped entirely rather than left as a broken-image icon
  — the model has no legitimate URL to reference in the first place, so this
  only ever removes a hallucinated one. `contenteditable` is also stripped
  from every element: the description preview is directly editable in place,
  and a saved edit is re-run through this same sanitizer before it replaces
  the stored HTML, so that attribute can never leak into a saved description
  or the zip export.
- A `Content-Security-Policy` meta tag adds a second, independent layer on
  top of that sanitizer: no inline or external scripts, no inline styles, no
  `<object>`/`<embed>`, fonts restricted to this same origin (`font-src
  'self'` — the two fonts are self-hosted from `fonts/`, see Files below),
  and `connect-src` restricted to the MIT Parley endpoint — so even a
  sanitizer bug couldn't be used to run script or exfiltrate data to another
  host. The `.zip` and project-file exports are plain `<a download>` links
  to in-browser blobs — downloads aren't governed by `img-src`, so the CSP
  needs no allowance for them, and those exports never leave the browser.

## Version number

The small badge next to the title (e.g. `v12`) is a build number that
increases with every commit, generated by a git hook rather than tracked by
hand — so it can't drift out of sync with the actual commit history.

`.githooks/pre-commit` regenerates `version.js` (which just sets
`window.APP_VERSION`) from `git rev-list --count HEAD` immediately before
every commit, and stages it into that same commit. Git doesn't run hooks from
a repo automatically (that would let a cloned repo execute arbitrary code on
your machine), so after cloning, enable it once with:

```sh
git config core.hooksPath .githooks
```

Without that, `version.js` simply won't update on new commits, and the page
falls back to showing "dev".

## Files

- `index.html` — page structure: onboarding screen, workspace, settings
  dialog, and the rail-row/detail-pane `<template>`s
- `style.css` — styling: the Living Isle design system (bold poster colors,
  thick ink outlines, flat "pop" shadows, playful display type); a single
  warm palette, no dark-mode scope
- `app.js` — settings, batch upload/queue handling, image optimization, cost
  estimation, the API calls (with retry/backoff), review/approve/revision
  state, zip export, sanitizing/rendering, and copy-to-clipboard
- `fonts/` — self-hosted `Bungee-Regular.woff2`, `BungeeShade-Regular.woff2`,
  `Boogaloo-Regular.woff2`, and `Quicksand-Variable.woff2` (see the note at
  the top of `style.css`); without them the fallback font stack is used and
  nothing breaks
- `preview-only.html` — a CSP-stripped copy of `index.html` used only for
  taking design screenshots; not part of the deployed app
- `version.js` — generated by `.githooks/pre-commit`; not hand-edited
- `.githooks/pre-commit` — regenerates `version.js` on every commit
