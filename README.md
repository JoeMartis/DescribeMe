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

1. Open the page.
2. Expand **API Settings** and enter your MIT Parley API key
   (`sk-parley-v1-...`).
3. Choose whether to remember the key for this tab only, on this device, or
   not at all (the default — nothing is written to storage, and the key only
   lives in page memory until you reload).
4. Pick a **Model**. The three options are the best fits for this task,
   listed cheapest to most expensive:
   - **Claude Haiku 4.5** ($1 / $5 per MTok) — fastest and cheapest; a strong
     default for most slides.
   - **Claude Sonnet 5** ($3 / $15 per MTok) — sharper on dense equations and
     smaller text.
   - **Claude Opus 5** ($5 / $25 per MTok) — most thorough; best for crowded,
     multi-part figures.
5. Optionally adjust **Max simultaneous requests** — how many slides are
   described in parallel when you process a batch (default 3).
6. Drag and drop slide images (or click to browse) — PNG, JPEG, WebP, or GIF,
   up to 5 MB each and 25 per batch. Large images are automatically resized
   in your browser before upload.
7. Click **Describe all**. Each slide gets its own card with a rendered
   preview, copy buttons for the HTML and plain text, and a collapsible raw
   HTML source view. Failed items get a **Retry** button; you can **Stop** a
   batch mid-run, and remove or re-run individual slides at any time.

Nothing is uploaded to any server other than the MIT Parley endpoint. There is
no backend for this site — GitHub Pages only serves the static files.

## Making the API calls efficient

A few things keep batches fast and cheap:

- **Client-side image downscaling.** Images are resized in-browser (via
  `<canvas>`) to at most 1568px on the long edge before upload — Claude
  downsamples larger images internally anyway, so sending them at full
  resolution only adds tokens and upload time without improving the
  description. Small images are sent unmodified.
- **Bounded concurrency.** Slides in a batch are described in parallel, up to
  the configurable "Max simultaneous requests" limit (default 3), instead of
  either running one at a time (slow) or firing everything at once (likely to
  hit rate limits and waste retries).
- **Automatic retry with backoff.** Rate-limit (429) and server (5xx)
  responses, and transient network failures, are retried with exponential
  backoff (respecting the API's `retry-after` header when present) instead of
  failing the whole slide on the first hiccup.
- **A single request per slide.** Each image gets exactly one Messages API
  call — no unnecessary round trips.

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
`/v1/messages` exactly as the Anthropic SDK would, using the key you enter in
**API Settings**.

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
- Model output is sanitized before being rendered (script/iframe/style tags
  and `on*`/`javascript:` attributes are stripped) before it's inserted into
  the page, since the description is model-generated content derived from an
  uploaded image.

## Files

- `index.html` — page structure and controls
- `style.css` — styling (light/dark aware)
- `app.js` — settings, batch upload/queue handling, image optimization, the
  API calls (with retry/backoff), sanitizing/rendering, and copy-to-clipboard
