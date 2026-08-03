# cartograms

Source for the interactive cartogram pages published into
[jcervas.github.io](https://github.com/jcervas/jcervas.github.io):

| this repo        | published as                       |
| ---------------- | ---------------------------------- |
| `web/`           | `/maps/cartogram-studio/`          |
| `placement/`     | `/maps/cartogram-placement/`       |

## Read this first: the history was lost

This repository was reset to an empty state — a single commit, `Start over`,
containing no files at all. Whatever build tooling and development history
existed before that is gone and is not recoverable from here.

What is in this tree was **reconstructed from the published output** in
jcervas.github.io, which was the only surviving copy of the code. It is a
faithful copy of what is live, not a recovery of the original sources. Two
things follow, and both matter:

- **The publish step has been rewritten**, in `bin/publish.js`. The original was
  lost with everything else, but the scheme it used was recoverable by reading
  the published output: the content hash is the first eight hex characters of
  the file's SHA-256. That reproduces `solver.8ed51b2d.js`, `studio.css`
  (`e71a68a4`), and all four placement assets exactly. The one thing it does not
  reproduce is the old worker filename, whose hash matches no surviving form of
  that file — harmless, since the hash exists only to stop a browser serving a
  stale solver.
- **Hand edits in jcervas.github.io are overwritten again.** The warning in that
  repo's `_config.yml` — that edits to the generated map pages are wiped on the
  next publish — went dormant when the tooling was lost, and `bin/publish.js`
  makes it true once more. Edit the studio and the placement walkthrough here,
  never there.

## What was changed during reconstruction

The published files were copied verbatim except for three reference edits,
made so that this tree is coherent and directly runnable. To go back to
exactly what is published, reverse them:

1. `web/studio.worker.js` — `importScripts("solver.8ed51b2d.js")` became
   `importScripts("solver.js")`.
2. `web/index.html` — `solver.8ed51b2d.js` became `solver.js`, and
   `studio.worker.fa1aa6ad.js` became `studio.worker.js`.
3. `web/index.html` — the `?v=<hash>` query strings were dropped from the
   `studio.css`, `studio.js` and `studio.json` references.

`web/index.html` keeps its Jekyll front matter and Liquid `relative_url`
filters, because the generator emitted the page complete with them.

## Layout

The `web/solver.js` path is the one name that is certain: the published page
credits it directly. Everything else is inferred from what the pages load, so
treat the arrangement as a reasonable guess rather than the original.

```
web/
  index.html         the studio page, front matter and all
  solver.js          the solver: placement, carving, assignment
  studio.worker.js   worker wrapper; importScripts the solver
  studio.js          UI, controls, rendering
  studio.css
  studio.json        prebuilt geography and seat data (generated, ~600 KB)
placement/
  index.md           the placement walkthrough
  placement.js
  placement.css
  placement.json
  doc.css
```

`studio.json` and `placement.json` are generated data, not hand-written. The
pipeline that produced them (R, per the studio's own copy: "the same cartogram,
solved in your browser instead of in R") is not in this repository either.

## Publishing

```
node bin/publish.js ../jcervas.github.io
```

Hashes the solver, substitutes that name into the worker, hashes the worker,
copies everything across, rewrites the references and the `?v=` strings, stamps
the date, and deletes any hashed file the run did not itself write. Idempotent:
re-running with nothing changed reproduces the same names.

Two things it is careful about, both learned the hard way. The worker names the
solver, so the solver must be hashed and substituted *before* the worker is
hashed, or the name will not describe the file it is attached to. And the
substitution is confined to the Liquid asset paths — a blanket replace of
`solver.js` also rewrites the page's own prose, which credits `web/solver.js`
and mentions `sh/12_test_solver.js`.
