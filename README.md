# DescribeMe

A tiny, standalone web app that generates screen-reader-friendly extended
descriptions of STEM lecture slides using Claude. Upload a slide image, click
**Describe slide**, and get back semantic HTML (with MathML for equations)
ready to embed next to the slide.

The whole thing is static HTML/CSS/JS — no build step, no backend. It calls
the Anthropic Messages API directly from your browser using an API key you
supply, and is designed to be hosted for free on GitHub Pages.

## Using it

1. Open the page.
2. Expand **API Settings** and enter your API key.
   - A normal Anthropic API key (`sk-ant-...`), **or**
   - An MIT Parley key (`sk-parley-v1-...`) — set the **API base URL** field
     to `https://parley.api.mit.edu` when using this.
3. Choose whether to remember the key for this tab only, on this device, or
   not at all (the default — nothing is written to storage, and the key only
   lives in page memory until you reload).
4. Upload a slide image (PNG, JPEG, WebP, or GIF, up to 5 MB).
5. Click **Describe slide**. The result appears as a rendered preview, raw
   HTML source you can copy and embed, and a plain-text version.

Nothing is uploaded to any server other than the Anthropic API endpoint you
configure. There is no backend for this site — GitHub Pages only serves the
static files.

## Hosting on GitHub Pages

1. Push this repository to GitHub.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to `Deploy from a branch`,
   pick the branch (e.g. `main`) and the `/ (root)` folder.
4. Save. GitHub will publish the site at
   `https://<your-username>.github.io/<repo-name>/`.

No secrets or environment variables are needed at deploy time — the API key
is entered by whoever uses the page, in their own browser.

## About the MIT Parley key

MIT Parley proxies requests to the Anthropic API. The setup instructions for
using it with Anthropic's own tools are:

```
export ANTHROPIC_BASE_URL=https://parley.api.mit.edu
export ANTHROPIC_API_KEY=sk-parley-v1-...your-key...
```

This app has no environment to read those variables from (it's static, and
your key should never live in a committed file), so instead you paste the key
into the **API key** field and set **API base URL** to
`https://parley.api.mit.edu`. The app sends requests to
`{base URL}/v1/messages` exactly as the Anthropic SDK would.

## Security notes

- Your API key is only ever sent as an `x-api-key` header on requests to the
  base URL you configure — it is never sent anywhere else, and this site has
  no server component to intercept or log it.
- By default the key is kept only in page memory and is gone as soon as you
  reload or close the tab. The "remember" options use your browser's
  `sessionStorage`/`localStorage`, entirely client-side.
- Because this calls the Anthropic API directly from a browser, it sends the
  `anthropic-dangerous-direct-browser-access: true` header, which is required
  for browser-based requests. Anyone who can read your page's network traffic
  (e.g. via browser devtools) can see your API key, the same as with any
  client-side API key usage — don't use a key with broader scope than you're
  comfortable exposing in your own browser.
- Model output is sanitized before being rendered (script/iframe/style tags
  and `on*`/`javascript:` attributes are stripped) before it's inserted into
  the page, since the description is model-generated content derived from an
  uploaded image.

## Files

- `index.html` — page structure and controls
- `style.css` — styling (light/dark aware)
- `app.js` — settings, upload handling, the API call, sanitizing/rendering,
  and copy-to-clipboard
