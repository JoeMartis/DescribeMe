# vendor/

Third-party files used by the learner PDF (`learner-pdf.mjs`). They are
checked in, not fetched from a CDN, for two reasons: the page's Content
Security Policy allows no other host, and nothing about a course should leave
the browser to make a learner download. None of this loads until someone
selects **Download PDF**.

| Path | What it is | Version | Source | Licence |
| --- | --- | --- | --- | --- |
| `typst/typst_ts_web_compiler.mjs`, `typst/typst_ts_web_compiler_bg.wasm` | The Typst compiler, built for the browser by the typst.ts project. Includes Typst's tagged-PDF support (Typst 0.14). | `@myriaddreamin/typst-ts-web-compiler` 0.7.0 | npm | Apache-2.0 (`typst/LICENSE`) |
| `fonts/LibertinusSerif-*.otf` | Body text, regular, bold, italic and bold italic | from `typst-assets` 0.14.0 | crates.io | SIL OFL 1.1 (`fonts/NOTICE`) |
| `fonts/NewCMMath-Regular.otf` | Math (New Computer Modern Math) | from `typst-assets` 0.14.0 | crates.io | GUST Font License (`fonts/NOTICE`) |
| `fonts/DejaVuSansMono.ttf` | Code, for the rare description that has some | from `typst-assets` 0.14.0 | crates.io | Bitstream Vera / DejaVu (`fonts/NOTICE`) |
| `sre/sre.js`, `sre/mathmaps/base.json`, `sre/mathmaps/en.json` | Speech Rule Engine — the spoken reading of each equation, used as its alt text | `speech-rule-engine` 4.1.5 | npm | Apache-2.0 (`sre/LICENSE`) |

## The one local change

`typst/typst_ts_web_compiler.mjs` is patched, and the patch is marked at the
top of the file. The compiler builds a few tiny JavaScript functions from
strings with `new Function(...)` — placeholders for its file system and
package registry, and a lookup of the global object. DescribeMe's CSP allows
no string evaluation, and should not have to, so the patch supplies those
functions directly from a fixed list of every such string in this `.wasm`.
Any string not on the list throws an error that names it.

To check the list against a new build:

```sh
strings -n 8 vendor/typst/typst_ts_web_compiler_bg.wasm | grep -E "^(return |throw new Error\()"
```

## Upgrading

1. Replace the files above from the same sources, at the new versions.
2. Re-apply the patch, and re-check the list of strings as above.
3. Run `node test/run.mjs regress18`, ideally with veraPDF available
   (`VERAPDF_LIB`, see `test/README.md`) — it checks that the PDF still
   passes PDF/UA-1.

`learner-pdf.mjs` adds PDF/UA-1's identification to Typst's output by reading
the file's layout (see `claimPdfUa`). This version of the web compiler has no
switch for the PDF standard; if a later one does, use it and drop that step.
