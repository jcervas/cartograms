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

- **The publish step is not here.** Something used to copy these files into
  jcervas.github.io, rename `solver.js` and `studio.worker.js` to include a
  content hash, and stamp `?v=` cache-busting strings onto the CSS and JS
  references. That script was not recovered. Publishing is currently a manual
  copy — see below.
- **Nothing in jcervas.github.io is overwritten automatically any more.** The
  warning in that repo's `_config.yml`, that hand edits to generated map pages
  get wiped on the next publish, is dormant while no publish step exists. It
  becomes true again the moment one is written.

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

## Publishing, until a script exists

Copy into `jcervas.github.io/maps/`, restoring the hashed names and cache
busting, then update the references in the published `index.html` to match. The
hash is over the file contents; any scheme works as long as the name changes
when the contents do, since its only job is to stop browsers serving a stale
solver.
