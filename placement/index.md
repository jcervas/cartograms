---
layout: subpage
title: "How the cartogram is built"
description: "The whole pipeline behind the equal-area House cartograms: sizing every state to its seat count, placing them with soft bodies so nothing overlaps, carving each into equal-area district cells, and matching those cells to real districts."
permalink: /maps/cartogram-placement/
---

<link rel="stylesheet" href="{{ '/maps/cartogram-placement/placement.css' | relative_url }}?v=d8f14054">
<link rel="stylesheet" href="{{ '/maps/cartogram-placement/doc.css' | relative_url }}?v=731607ed">

<div class="pl" id="pl" data-src="{{ '/maps/cartogram-placement/placement.json' | relative_url }}?v=8643e5af">
  <div class="pl-header">
    <div class="pl-eyebrow">Cartogram pipeline</div>
    
    <p class="pl-lede">Every congressional district drawn the same size, so the map shows representation rather than land. Step through the placement stage below &mdash; this is the real geometry the build produces &mdash; then read how the whole thing works.</p>
    <div class="pl-meta">
      <div><span class="pl-k">Frame</span><span class="pl-v" id="pl-m-frame"></span></div>
      <div><span class="pl-k">States</span><span class="pl-v">50 &middot; 435 districts</span></div>
      <div><span class="pl-k">Largest scale</span><span class="pl-v" id="pl-m-max"></span></div>
      <div><span class="pl-k">Smallest scale</span><span class="pl-v" id="pl-m-min"></span></div>
    </div>
  </div>

  <div class="pl-layout">
    <div class="pl-stage">
      <svg id="pl-map" viewBox="0 0 1152 749" role="img"
           aria-label="Map of US states moving through the placement stages"></svg>
      <div class="pl-stagebar">
        <span class="pl-lab" id="pl-stage-label"></span>
        <span class="pl-val" id="pl-stage-val"></span>
        <span class="pl-nav">
          <button id="pl-prev" type="button">&larr; Back</button>
          <button id="pl-next" type="button">Next &rarr;</button>
        </span>
      </div>
    </div>

    <div>
      <ol class="pl-steps" id="pl-steps"></ol>
    </div>
    </div>
</div>

<script src="{{ '/maps/cartogram-placement/placement.js' | relative_url }}?v=c2bb0a20" defer></script>

<div class="cgdoc" markdown="1">

A cartogram where every congressional district is drawn the same size, so the map
shows representation instead of land. Fifty states, 435 districts, and no step
that a person has to do by hand.

The map above is the real geometry the build produces, stepped through stage by
stage — not a diagram of it.

---

## The shape of it

| Stage | Owned by |
|---|---|
| Boundaries → project → simplify → dissolve | mapshaper |
| Scale each state so its area matches its seats | numeric |
| Place the states so nothing overlaps | numeric |
| Carve each state into one equal-area cell per seat | numeric |
| Match cells to real districts | numeric |
| Write the JSON | numeric |

Anything topological is mapshaper's: projection, simplification, dissolve,
polygon intersection. Everything numerical is base R with no packages beyond what
ships with the language, and is also ported to JavaScript so the whole thing can
be re-solved in a browser.

## 1. Boundaries

Congressional district boundaries, projected to Albers USA, simplified with
Visvalingam weighted at 4%, and dissolved to state outlines. This is the only
stage with an external dependency and the only one that is not re-runnable in the
browser — its output ships as data.

## 2. Scale to seats

Each state is scaled about its own centre so that its **area is proportional to
its seat count**. That is the entire claim the cartogram makes, and everything
downstream has to preserve it.

The scale factor is `sqrt(totalArea × seatShare / stateArea / divisor)`. Wyoming,
with one seat and a great deal of land, shrinks to about a sixth of its size; New
Jersey, with twelve seats in very little land, nearly doubles. Those two numbers
— 0.16× and 1.87× — are worth holding onto, because the spread between them is
what makes placement hard.

## 3. Placement

Now the states overlap, and something has to separate them.

### The collision test is the whole problem

Every reasonable solver does roughly the same thing; what decides the outcome is
**what you call a collision**. Measured on this map at 2 px padding:

| Treating each state as | States that must move |
|---|---|
| a circle | 80 |
| its bounding box | 34 |
| its actual outline | 1 |

A circle around Florida covers most of the Gulf. A box around Idaho covers
Montana. Only the outline knows that Florida's panhandle slots under Alabama, and
the difference is not marginal — it is 80 collisions against one.

So collision is tested on the outlines, sampled: points spaced along every
boundary, each carrying a disc of radius half the padding. Two states are too
close when any two of their discs are. It is exact where it matters and needs no
polygon intersection.

### Two ways to place them

**Hand-drawn slots.** Karim Douieb's original notebook placed all fifty states by
hand in Figma. It is the nicest result on this particular map, because a person
did it — but it is drawn for one particular set of seat counts, and it stops
working as soon as they change. Give every state two seats, as the Senate does,
and Wyoming needs about six times the room its slot allows.

**Soft bodies**, which need no hand-drawn layout at all and are the method the
rest of this page describes.

### Soft bodies

Each state is packed with a hex lattice of equal-radius circles and seeded at its
true centroid. Then three rules run together until nothing moves:

- **Shape.** The lattice is split into overlapping clusters and every cluster is
  projected each step onto the best linear transform of its rest shape — shape
  matching, after Müller et al. (2005).
- **Borders.** Circles sitting on a shared border are tied to their counterparts
  across it.
- **Separation.** Circles belonging to different states may not overlap.

Three things fall out of that, and each replaced something that had been fought
for separately:

**Area becomes exact, not iterated.** A cluster's area is precisely `det(T)`
times its rest area, so forcing `det(T) = 1` makes area-proportional-to-seats
hold by construction. Before shape matching this was a correction loop that
converged on the lattice and still left the drawn outlines 50–88% wrong.

**Folding becomes impossible rather than penalised.** A mass-spring lattice can
pass through itself with every edge still at its rest length — the fold cancels,
so the area measures correct while the outline carried through it comes out
inside-out. Under shape matching that configuration is not available, because the
only configurations available are `T q + c`.

**The gap comes free.** The circles are sampled inside the polygon but drawn with
a radius slightly larger than the lattice spacing, so they bulge past the border.
"Circles may not overlap" therefore already means "outlines may not overlap", and
padding is not a separate rule. Undersizing that radius is what left Arizona
drawn over New Mexico in an earlier version.

### The lattice is a cage, not the drawing

The circles are never drawn. Because the lattice keeps its position inside the
state, it doubles as a deformation cage: once the solve is done the real state
outline is carried back through it by moving least squares, and what appears on
screen is the state.

### Where two states touch, not just that they touch

Borders are cut into segments and the circles on each segment are tied across the
line. A single link between two centres of mass says only *that* two states are
neighbours — and it drags Connecticut toward the middle of New York, which is
upstate, when what actually holds them together is a stretch of border down by
the Sound. Several anchors along one border also pin orientation, because a
turned or displaced state cannot satisfy all of them at once.

Measured on a test neither method optimises — fit the best uniform scale and
translation taking the true state centres to the drawn ones, then report the
residual:

| | arrangement error |
|---|---|
| One link per border, centroid to centroid | 33.1% |
| Anchors along each border | **29.0%** |

Anchors are thinned to 25 px apart. That is measured rather than chosen: closer
spacing gives more anchors but a *worse* arrangement, and at 14 px it produces
overlapping pairs. A long border outvoting every short one is the failure mode,
and thinning is the control for it — California/Nevada gets ten anchors,
Delaware/Maryland two.

### What is annealed, and why

Shape matching and separation are directly opposed: one wants a state to be an
undeformed copy of itself, the other wants it out of its neighbour's way. Held at
constant strength they trade blows forever and the run ends with hundreds of
pairs still overlapping. The shape constraint is therefore annealed toward a
floor — never to zero, because passes with it switched off are free to push
lattice points anywhere, and they smeared outlines by a median of 17%.

Rotation is deliberately **not** allowed. Shape matching normally blends toward
the closest rotation, which is right for a physics simulation and wrong for a
map: a reader identifies a state by its silhouette and its orientation together,
so a turned New York reads as an error however well packed it is.

## 4. Carve into cells

Each state is subdivided into as many cells as it has seats, and the cells must
come out roughly **equal in area** — a district's cell should carry the same
visual weight whether it covers half of Montana or six blocks of Manhattan.

1. **Sample.** Scatter uniform random points across the state, 600 per seat.
   Points are allocated between a state's parts in proportion to area, so islands
   and peninsulas get their share. This is the only randomness in the pipeline
   and it is seeded, so a rebuild reproduces the same cells exactly.
2. **Cluster.** k-means on a *uniform* point cloud is the trick: because the
   points are spread evenly over the area, clusters holding an equal number of
   points are clusters holding an equal amount of **area**.
3. **Balance.** k-means equalises variance, not area, and in an awkward shape
   those come apart badly — Florida's largest cell ends up 4.8× its smallest.
   Alternating a Lloyd step with a capacity step turns the Voronoi diagram into a
   power diagram and brings that to 1.15×.
4. **Clip** to the state outline.

Because the sample points lie *inside* the state, the count a site captures is a
Monte-Carlo estimate of its cell's area **after** clipping — which is the area
that actually matters. Measuring the raw cell polygons instead reports ~17× for
both methods and hides the whole effect.

Across all fifty states the worst within-state area ratio falls from 5.53 to
1.24, and the median from 1.38 to 1.11.

## 5. Match cells to districts

Carving gives the right *number* of cells but says nothing about which cell
belongs to which district. Something has to pair them, and the pairing is what
the morph animates along.

Pair each district with exactly one cell so that the **total squared distance**
between their centres is as small as possible. That is a linear assignment
problem. Greedy pairing is not optimal and the failure is visible: one district
gets stranded and has to cross the state to reach the last free cell. The optimum
is found exactly by the Hungarian algorithm — about sixty lines, no packages.

Squaring penalises one long journey more than several short ones, so the optimum
spreads the displacement around rather than accepting a single state-crossing
move.

## 6. In the browser

The whole numerical half is ported to JavaScript, so the cartogram can be
re-solved live rather than only read back from a finished file. Try it in
[the studio](https://jonathancervas.com/maps/cartogram-studio/): change the
padding, the state size, the seat counts or the geography and watch it re-solve.

Only the numerical stages moved. Projection, simplification and dissolve stay
with mapshaper and ship as data. Clipping the cells to the state — the one
genuinely hard piece of geometry — is done by the browser at paint time with an
SVG `clipPath`, which is why the page needs no polygon-clipping library.

It will not reproduce the R build pixel for pixel, and cannot. The separation is
a Gauss–Seidel iteration, which is chaotic: a 10⁻¹³ floating-point difference in
the first sweep grows by roughly a factor of ten per iteration, so after a
hundred it is a few pixels. What survives is the invariant, which is the thing
worth guaranteeing — no two states closer than the padding, and an optimal
assignment.

## How it is checked

The port is verified against the R build on every run. It cannot compare
geometry, because R's RNG is not reproducible in JavaScript, so it compares
properties — sixty checks, of which the ones that carry the most weight are:

- The ported Hungarian, handed the R build's own cells, returns the identity
  assignment at the identical cost. That is the strongest statement available
  without matching floating point.
- The separation, started from the layout R shipped, finds nothing to move: the
  two implementations agree on what "legal" means.
- Adjacency is checked against facts rather than a stored answer — 109 borders,
  Missouri and Tennessee eight neighbours each, Maine only New Hampshire, Alaska
  and Hawaii none, and the same answer anywhere between a 1 px and a 4 px
  tolerance.
- The projection used for uploaded geography is equal-area to within 0.0000%,
  tested on graticule cells of known equal area. That is not a preference: the
  cartogram scales every region so drawn area tracks seat count, which is only
  meaningful if the source areas tracked ground area.

## Where the code lives

| File | Role |
|---|---|
| `sh/01_prep_geo.sh` | mapshaper: project, simplify, dissolve |
| `R/lib_geom.R` | Sampling, balancing, power diagram, half-plane clipping |
| `R/lib_assign.R` | The Hungarian algorithm and its brute-force self-test |
| `R/lib_discs.R` | Boundary discs and the rigid-body separation |
| `web/solver.js` | The whole numerical half, ported: geometry, sampling, k-means, balancing, cells, adjacency, border segments, soft bodies, Hungarian |
| `sh/12_test_solver.js` | Checks the port against the R build |

Source: [github.com/jcervas/cartograms](https://github.com/jcervas/cartograms)

---

*Updated 1 August 2026.*

</div>
