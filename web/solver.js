/* solver.js -- the cartogram solvers, in the browser.
 *
 * A port of the numerical half of the R pipeline: sampling, k-means, the
 * area-balancing power diagram, boundary-disc relaxation, and the Hungarian
 * assignment. Everything here is pure -- geometry in, geometry out -- so it runs
 * in a worker, a page, or node.
 *
 * What is NOT ported, and does not need to be:
 *
 *   projection, simplification, dissolve   done once, shipped as data
 *   clipping cells to the state            done by SVG <clipPath> at render time
 *
 * That second one is the reason this needs no polygon-clipping library. The R
 * pipeline asks mapshaper to intersect each convex cell with the state outline;
 * a browser can just clip the whole group of cells with the outline as it paints
 * them. Visually identical, and the hardest geometry disappears.
 *
 * The consequence, stated plainly: cells produced here are the raw convex ones,
 * so their coordinates run past the state border. Anything that needs true
 * clipped geometry -- exact areas, an exported file -- should come from the R
 * build, not from here.
 *
 * Exports a single object so it can be loaded as a plain script or imported.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CartogramSolver = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* Deterministic PRNG. R's RNG cannot be reproduced here, so the two
   * implementations will never give bit-identical cells -- but each is
   * reproducible on its own, which is what a seed is for. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------- geometry ----

  /* geom is a list of parts; a part is a list of rings; a ring is a flat array
   * of [x, y]. Matches the R representation and the GeoJSON coordinate nesting
   * with one level removed. */

  function ringArea2(ring) {
    let s = 0;
    for (let i = 0; i < ring.length - 1; i++)
      s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    return s;
  }

  function partArea(part) {
    let a = Math.abs(ringArea2(part[0]) / 2);
    for (let i = 1; i < part.length; i++) a -= Math.abs(ringArea2(part[i]) / 2);
    return a;
  }

  function geomArea(geom) {
    let a = 0;
    for (const p of geom) a += partArea(p);
    return a;
  }

  function bbox(geom) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const part of geom) for (const ring of part) for (const p of ring) {
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
    return [x0, y0, x1, y1];
  }

  /* Even-odd crossing test against every ring of a part, so holes drop out. */
  function pointInPart(x, y, part) {
    let inside = false;
    for (const ring of part) {
      for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
        const yi = ring[i][1], yj = ring[j][1];
        if ((yi > y) !== (yj > y)) {
          const xi = ring[i][0], xj = ring[j][0];
          if (x < xi + ((y - yi) / (yj - yi)) * (xj - xi)) inside = !inside;
        }
      }
    }
    return inside;
  }

  function pointInGeom(x, y, geom) {
    for (const part of geom) if (pointInPart(x, y, part)) return true;
    return false;
  }

  /* Rejection sampling makes hundreds of thousands of point-in-polygon calls
   * against outlines totalling ~42k vertices, and that one loop was most of the
   * carve. So bucket the edges by y: a query only has to test the edges whose
   * span crosses its own row. Same crossing test, same answer, ~10x less work.
   *
   * Stored CSR-style (counts -> offsets -> fill) to keep it to two typed arrays
   * rather than an array of arrays. */
  function buildPIP(part) {
    let m = 0;
    for (const ring of part) m += Math.max(0, ring.length - 1);
    const x0 = new Float64Array(m), y0 = new Float64Array(m);
    const x1 = new Float64Array(m), y1 = new Float64Array(m);
    let e = 0, ymin = Infinity, ymax = -Infinity;
    for (const ring of part) {
      for (let i = 0; i < ring.length - 1; i++) {
        x0[e] = ring[i][0]; y0[e] = ring[i][1];
        x1[e] = ring[i + 1][0]; y1[e] = ring[i + 1][1];
        if (y0[e] < ymin) ymin = y0[e];
        if (y1[e] < ymin) ymin = y1[e];
        if (y0[e] > ymax) ymax = y0[e];
        if (y1[e] > ymax) ymax = y1[e];
        e++;
      }
    }
    const rows = Math.max(8, Math.min(1024, Math.ceil(Math.sqrt(m)) * 2));
    const h = (ymax - ymin) / rows || 1;
    const row = (v) => Math.max(0, Math.min(rows - 1, Math.floor((v - ymin) / h)));

    const count = new Int32Array(rows + 1);
    for (let i = 0; i < m; i++) {
      const a = row(Math.min(y0[i], y1[i])), b = row(Math.max(y0[i], y1[i]));
      for (let r = a; r <= b; r++) count[r + 1]++;
    }
    for (let r = 0; r < rows; r++) count[r + 1] += count[r];
    const items = new Int32Array(count[rows]);
    const at = count.slice(0, rows);
    for (let i = 0; i < m; i++) {
      const a = row(Math.min(y0[i], y1[i])), b = row(Math.max(y0[i], y1[i]));
      for (let r = a; r <= b; r++) items[at[r]++] = i;
    }
    return { x0, y0, x1, y1, ymin, ymax, h, rows, off: count, items };
  }

  function pipIndexed(x, y, ix) {
    if (y < ix.ymin || y > ix.ymax) return false;
    const r = Math.max(0, Math.min(ix.rows - 1, Math.floor((y - ix.ymin) / ix.h)));
    let inside = false;
    for (let k = ix.off[r]; k < ix.off[r + 1]; k++) {
      const i = ix.items[k];
      const ya = ix.y0[i], yb = ix.y1[i];
      if ((ya > y) !== (yb > y)) {
        const xa = ix.x0[i], xb = ix.x1[i];
        if (x < xa + ((y - ya) / (yb - ya)) * (xb - xa)) inside = !inside;
      }
    }
    return inside;
  }

  // ------------------------------------------------------------- sampling ----

  /* n uniform points over a geometry, allocated between its parts by area so
   * islands get their fair share, then rejection-sampled in each part's box. */
  function samplePoints(geom, n, rand) {
    const areas = geom.map(partArea);
    const total = areas.reduce((a, b) => a + b, 0);
    const out = new Float64Array(n * 2);
    let w = 0;

    for (let pi = 0; pi < geom.length && w < n; pi++) {
      const part = geom[pi];
      // largest-remainder share, with the last part taking whatever is left
      let want = pi === geom.length - 1
        ? n - w
        : Math.round((n * areas[pi]) / total);
      if (want <= 0) continue;

      const b = bbox([part]);
      const bw = b[2] - b[0], bh = b[3] - b[1];
      if (bw <= 0 || bh <= 0) continue;

      const ix = buildPIP(part);
      let guard = 0;
      const cap = Math.max(2000, want * 400);
      while (want > 0 && guard < cap) {
        const x = b[0] + rand() * bw;
        const y = b[1] + rand() * bh;
        guard++;
        if (pipIndexed(x, y, ix)) {
          out[w * 2] = x;
          out[w * 2 + 1] = y;
          w++; want--;
        }
      }
    }
    // a degenerate sliver can starve: fall back to its vertices
    if (w < n) {
      const verts = geom[0][0];
      for (let i = w; i < n; i++) {
        const v = verts[i % verts.length];
        out[i * 2] = v[0]; out[i * 2 + 1] = v[1];
      }
    }
    return out;
  }

  // -------------------------------------------------------------- k-means ----

  /* Lloyd's algorithm with k-means++ seeding. R uses Hartigan-Wong; the
   * difference does not matter here because the balancing pass that follows
   * moves the sites anyway. */
  function kmeans(pts, k, rand, iters = 60) {
    const n = pts.length / 2;
    const cx = new Float64Array(k), cy = new Float64Array(k);

    // k-means++: first centre at random, each next favouring distant points
    let i0 = Math.floor(rand() * n);
    cx[0] = pts[i0 * 2]; cy[0] = pts[i0 * 2 + 1];
    const d2 = new Float64Array(n).fill(Infinity);
    for (let c = 1; c < k; c++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const dx = pts[i * 2] - cx[c - 1], dy = pts[i * 2 + 1] - cy[c - 1];
        const d = dx * dx + dy * dy;
        if (d < d2[i]) d2[i] = d;
        sum += d2[i];
      }
      let t = rand() * sum, pick = n - 1;
      for (let i = 0; i < n; i++) { t -= d2[i]; if (t <= 0) { pick = i; break; } }
      cx[c] = pts[pick * 2]; cy[c] = pts[pick * 2 + 1];
    }

    const lab = new Int32Array(n);
    const sx = new Float64Array(k), sy = new Float64Array(k);
    const cnt = new Int32Array(k);
    for (let it = 0; it < iters; it++) {
      let moved = false;
      sx.fill(0); sy.fill(0); cnt.fill(0);
      for (let i = 0; i < n; i++) {
        const x = pts[i * 2], y = pts[i * 2 + 1];
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          const dx = x - cx[c], dy = y - cy[c];
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = c; }
        }
        if (lab[i] !== best) { lab[i] = best; moved = true; }
        sx[best] += x; sy[best] += y; cnt[best]++;
      }
      for (let c = 0; c < k; c++)
        if (cnt[c]) { cx[c] = sx[c] / cnt[c]; cy[c] = sy[c] / cnt[c]; }
      if (!moved && it > 0) break;
    }
    return { cx, cy, lab, size: cnt };
  }

  // ------------------------------------------------------- area balancing ----

  /* Nearest site under the power distance |p - s|^2 - w. */
  function powerAssign(pts, cx, cy, w, lab) {
    const n = pts.length / 2, k = cx.length;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], y = pts[i * 2 + 1];
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dx = x - cx[c], dy = y - cy[c];
        const d = dx * dx + dy * dy - w[c];
        if (d < bd) { bd = d; best = c; }
      }
      lab[i] = best;
    }
    return lab;
  }

  /* Alternate a Lloyd step with a capacity step until every cell holds an equal
   * share of the points. Because the points lie inside the state, a site's count
   * is a Monte-Carlo estimate of its area AFTER clipping -- the area that
   * actually matters. */
  function balance(pts, cx, cy, iters = 60, eta = 0.5, tol = 0.02) {
    const n = pts.length / 2, k = cx.length;
    const target = n / k;
    const w = new Float64Array(k);
    const lab = new Int32Array(n);
    const cnt = new Int32Array(k);
    const sx = new Float64Array(k), sy = new Float64Array(k);

    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += pts[i * 2]; my += pts[i * 2 + 1]; }
    mx /= n; my /= n;
    let scale = 0;
    for (let i = 0; i < n; i++) {
      const dx = pts[i * 2] - mx, dy = pts[i * 2 + 1] - my;
      scale += dx * dx + dy * dy;
    }
    scale = scale / n / k;

    let best = { cx: cx.slice(), cy: cy.slice(), w: w.slice(), err: Infinity };
    for (let it = 0; it < iters; it++) {
      powerAssign(pts, cx, cy, w, lab);
      cnt.fill(0); sx.fill(0); sy.fill(0);
      for (let i = 0; i < n; i++) {
        const c = lab[i];
        cnt[c]++; sx[c] += pts[i * 2]; sy[c] += pts[i * 2 + 1];
      }
      let err = 0;
      for (let c = 0; c < k; c++) err = Math.max(err, Math.abs(cnt[c] - target) / target);
      if (err < best.err) best = { cx: cx.slice(), cy: cy.slice(), w: w.slice(), err };
      if (err < tol) break;

      for (let c = 0; c < k; c++) if (cnt[c]) { cx[c] = sx[c] / cnt[c]; cy[c] = sy[c] / cnt[c]; }
      let wm = 0;
      for (let c = 0; c < k; c++) { w[c] += eta * scale * (target - cnt[c]) / target; wm += w[c]; }
      wm /= k;
      for (let c = 0; c < k; c++) w[c] -= wm;
    }
    return best;
  }

  // ------------------------------------------------- power / Voronoi cells ----

  /* Sutherland-Hodgman clip of an open convex polygon to the half-plane of
   * points at least as close to si as to sj under the power distance. With
   * wi = wj = 0 this is the perpendicular bisector, so one routine serves both
   * the Voronoi and the power diagram. */
  function clipBisector(poly, six, siy, sjx, sjy, wi, wj) {
    const nx = sjx - six, ny = sjy - siy;
    const c0 = (sjx * sjx + sjy * sjy - six * six - siy * siy - wj + wi) / 2;
    const n = poly.length;
    const d = new Float64Array(n);
    let allIn = true, allOut = true;
    for (let i = 0; i < n; i++) {
      d[i] = poly[i][0] * nx + poly[i][1] * ny - c0;
      if (d[i] <= 0) allOut = false; else allIn = false;
    }
    if (allIn) return poly;
    if (allOut) return null;

    const out = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (d[i] <= 0) out.push(poly[i]);
      if ((d[i] <= 0) !== (d[j] <= 0)) {
        const t = d[i] / (d[i] - d[j]);
        out.push([poly[i][0] + t * (poly[j][0] - poly[i][0]),
                  poly[i][1] + t * (poly[j][1] - poly[i][1])]);
      }
    }
    return out.length < 3 ? null : out;
  }

  /* One convex cell per site, each clipped to the frame. O(k^2) -- k is at most
   * 52, for California. */
  function powerCells(cx, cy, w, box, pad = 0.02) {
    const k = cx.length;
    const dx = (box[2] - box[0]) * pad, dy = (box[3] - box[1]) * pad;
    const frame = [
      [box[0] - dx, box[1] - dy], [box[2] + dx, box[1] - dy],
      [box[2] + dx, box[3] + dy], [box[0] - dx, box[3] + dy]];
    const cells = [];
    for (let i = 0; i < k; i++) {
      let cell = frame;
      for (let j = 0; j < k && cell; j++) {
        if (i === j) continue;
        cell = clipBisector(cell, cx[i], cy[i], cx[j], cy[j],
                            w ? w[i] : 0, w ? w[j] : 0);
      }
      cells.push(cell);
    }
    return cells;
  }

  // --------------------------------------------------- boundary-disc relax ----

  /* Points spaced `spacing` apart along every ring, by arc length. */
  function boundaryDiscs(geom, spacing) {
    const out = [];
    for (const part of geom) for (const ring of part) {
      if (ring.length < 2) continue;
      let carry = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const ax = ring[i][0], ay = ring[i][1];
        const bx = ring[i + 1][0], by = ring[i + 1][1];
        const len = Math.hypot(bx - ax, by - ay);
        if (len === 0) continue;
        let t = carry;
        while (t < len) {
          out.push([ax + ((bx - ax) * t) / len, ay + ((by - ay) * t) / len]);
          t += spacing;
        }
        carry = t - len;
      }
    }
    return out;
  }

  /* Who borders whom, derived from the boundary samples themselves.
   *
   * Two regions are neighbours when their outlines come within `tol` of each
   * other in the ORIGINAL geography -- before any scaling or moving, because
   * that is the only place the real borders are. Since the outlines come from a
   * dissolve, a shared border is all but coincident; the tolerance only has to
   * absorb simplification.
   *
   * Reusing the boundary discs for this is the same trick as the collision test,
   * and it means an uploaded file gets adjacency for free rather than needing a
   * topology or a neighbour table. */
  function adjacency(geoms, tol) {
    tol = tol || 2;
    const n = geoms.length;
    const pts = geoms.map((g) => boundaryDiscs(g, Math.max(tol / 2, 0.5)));
    const ext = pts.map((d) => {
      let a = [Infinity, Infinity, -Infinity, -Infinity];
      for (const p of d) {
        if (p[0] < a[0]) a[0] = p[0]; if (p[1] < a[1]) a[1] = p[1];
        if (p[0] > a[2]) a[2] = p[0]; if (p[1] > a[3]) a[3] = p[1];
      }
      return a;
    });

    const h = Math.max(tol, 1);
    const grids = pts.map((d, i) => {
      const nx = Math.max(1, Math.ceil((ext[i][2] - ext[i][0]) / h) + 1);
      const ny = Math.max(1, Math.ceil((ext[i][3] - ext[i][1]) / h) + 1);
      const head = new Int32Array(nx * ny).fill(-1);
      const next = new Int32Array(d.length).fill(-1);
      for (let k = 0; k < d.length; k++) {
        const gx = Math.min(nx - 1, Math.max(0, Math.floor((d[k][0] - ext[i][0]) / h)));
        const gy = Math.min(ny - 1, Math.max(0, Math.floor((d[k][1] - ext[i][1]) / h)));
        const c = gy * nx + gx;
        next[k] = head[c]; head[c] = k;
      }
      return { nx, ny, x0: ext[i][0], y0: ext[i][1], head, next };
    });

    const links = [];
    const deg = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) {
      if (ext[i][0] - ext[j][2] > tol || ext[j][0] - ext[i][2] > tol ||
          ext[i][1] - ext[j][3] > tol || ext[j][1] - ext[i][3] > tol) continue;
      const A = pts[i], B = pts[j], G = grids[j];
      let touch = false;
      for (let a = 0; a < A.length && !touch; a++) {
        const qx = A[a][0], qy = A[a][1];
        const gx = Math.floor((qx - G.x0) / h), gy = Math.floor((qy - G.y0) / h);
        if (gx < -1 || gy < -1 || gx > G.nx || gy > G.ny) continue;
        for (let cy = Math.max(0, gy - 1); cy <= Math.min(G.ny - 1, gy + 1) && !touch; cy++)
          for (let cx = Math.max(0, gx - 1); cx <= Math.min(G.nx - 1, gx + 1) && !touch; cx++)
            for (let b = G.head[cy * G.nx + cx]; b !== -1; b = G.next[b]) {
              const dx = qx - B[b][0], dy = qy - B[b][1];
              if (dx * dx + dy * dy <= tol * tol) { touch = true; break; }
            }
      }
      if (touch) { links.push([j, i]); deg[i]++; deg[j]++; }
    }
    return { links, degree: deg };
  }

  /* Sequential (Gauss-Seidel) projection: each pair's correction is applied
   * immediately so later pairs see it. Summing every pair's push and applying
   * the total stalls -- a state boxed in on several sides sits at an
   * equilibrium with a constraint still violated.
   *
   * `groups[i]` names a rigid body; states sharing one move together and never
   * collide with each other.
   *
   * On reproducibility: this will not land on R's exact layout, and cannot. The
   * grid below computes the same contact as a brute-force scan -- verified pair
   * by pair -- but in a different floating-point order, and one iteration's
   * 5e-13 discrepancy grows by roughly 10x per iteration. After ~100 iterations
   * that is a few pixels. Gauss-Seidel is chaotic; every run here is a valid
   * re-solve, not a reproduction. What IS guaranteed is the invariant: no pair
   * closer than `padding`, checked independently in sh/12_test_solver.js. */
  function relaxDiscs(bodies, padding, opts) {
    opts = opts || {};
    const maxIter = opts.maxIter || 300;
    const step = opts.step == null ? 1 : opts.step;
    const spring = opts.spring == null ? 0.004 : opts.spring;
    const maxShift = opts.maxShift || 40;
    const tol = opts.tol == null ? 0.05 : opts.tol;
    const maxDiscs = opts.maxDiscs || 40000;
    const gravity = opts.gravity || 0;
    const gravityDecay = opts.gravityDecay == null ? 0.97 : opts.gravityDecay;
    const links = opts.links || null;
    const linkStrength = opts.linkStrength || 0;
    // links get their own schedule: they must undo the initial spread, which
    // takes longer than gravity needs to simply tighten
    const linkDecay = opts.linkDecay == null ? gravityDecay : opts.linkDecay;
    const n = bodies.length;

    /* Mass, so that a big state pulls a small one rather than the two meeting in
     * the middle. Everything below shares a correction between a pair inversely
     * to mass -- w_i = m_j/(m_i+m_j) -- which is the standard two-body split and
     * makes the heavier one move less. Default mass is the drawn area, since
     * that is what "larger" means on a cartogram. */
    const mass = bodies.map((b, i) =>
      b.mass != null ? Math.max(1e-6, b.mass) : Math.max(1e-6, geomArea(b.geom)));

    /* Spacing is padding/2, so halving the padding doubles the discs and
     * quadruples the naive pair cost. Back the spacing off until the total is
     * within budget, and report what was actually used -- a silent cap would
     * read as "solved at 0.5 px" when it was not. */
    let spacing = Math.max(padding / 2, 0.25);
    let discs = bodies.map((b) => boundaryDiscs(b.geom, spacing));
    let count = discs.reduce((a, d) => a + d.length, 0);
    while (count > maxDiscs) {
      spacing *= Math.sqrt(count / maxDiscs);
      discs = bodies.map((b) => boundaryDiscs(b.geom, spacing));
      count = discs.reduce((a, d) => a + d.length, 0);
    }
    const ext = discs.map((d) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of d) {
        if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1];
        if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1];
      }
      return [x0, y0, x1, y1];
    });

    /* A uniform grid over each body's discs, in that body's own frame -- so it
     * is built once even though the body moves. Cell size is the padding, so the
     * nearest disc within range is always in one of the nine cells around the
     * query point, and the pair test drops from |A|x|B| to |A|x(a few). */
    const grids = discs.map((d, i) => {
      const h = Math.max(padding, 0.5);
      const nx = Math.max(1, Math.ceil((ext[i][2] - ext[i][0]) / h) + 1);
      const ny = Math.max(1, Math.ceil((ext[i][3] - ext[i][1]) / h) + 1);
      const head = new Int32Array(nx * ny).fill(-1);
      const next = new Int32Array(d.length).fill(-1);
      for (let k = 0; k < d.length; k++) {
        const gx = Math.min(nx - 1, Math.max(0, Math.floor((d[k][0] - ext[i][0]) / h)));
        const gy = Math.min(ny - 1, Math.max(0, Math.floor((d[k][1] - ext[i][1]) / h)));
        const c = gy * nx + gx;
        next[k] = head[c];
        head[c] = k;
      }
      return { h, nx, ny, x0: ext[i][0], y0: ext[i][1], head, next };
    });

    const pos = bodies.map((b) => [b.x, b.y]);
    const seed = pos.map((p) => [p[0], p[1]]);
    const gid = bodies.map((b) => (b.group == null ? -1 : b.group));

    // a rigid group moves as one body, so it resists as one body too
    const groupMass = (i) => {
      if (gid[i] < 0) return mass[i];
      let m = 0;
      for (let k = 0; k < n; k++) if (gid[k] === gid[i]) m += mass[k];
      return m;
    };

    let it = 0, worst = 0;
    for (it = 0; it < maxIter; it++) {
      let hits = 0;
      worst = 0;
      for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) {
        if (gid[i] >= 0 && gid[i] === gid[j]) continue;
        const oix = pos[i][0], oiy = pos[i][1];
        const ojx = pos[j][0], ojy = pos[j][1];
        if (ext[i][0] + oix - (ext[j][2] + ojx) > padding ||
            ext[j][0] + ojx - (ext[i][2] + oix) > padding ||
            ext[i][1] + oiy - (ext[j][3] + ojy) > padding ||
            ext[j][1] + ojy - (ext[i][3] + oiy) > padding) continue;

        // deepest penetration between the two disc chains, via j's grid
        const A = discs[i], B = discs[j], G = grids[j];
        let bd = Infinity, bax = 0, bay = 0, bbx = 0, bby = 0;
        for (let a = 0; a < A.length; a++) {
          const ax = A[a][0] + oix, ay = A[a][1] + oiy;
          // the query point in j's local frame
          const qx = ax - ojx, qy = ay - ojy;
          const gx = Math.floor((qx - G.x0) / G.h), gy = Math.floor((qy - G.y0) / G.h);
          if (gx < -1 || gy < -1 || gx > G.nx || gy > G.ny) continue;
          for (let cy = Math.max(0, gy - 1); cy <= Math.min(G.ny - 1, gy + 1); cy++)
            for (let cx = Math.max(0, gx - 1); cx <= Math.min(G.nx - 1, gx + 1); cx++)
              for (let b = G.head[cy * G.nx + cx]; b !== -1; b = G.next[b]) {
                const dx = qx - B[b][0], dy = qy - B[b][1];
                const d = dx * dx + dy * dy;
                if (d < bd) { bd = d; bax = ax; bay = ay; bbx = B[b][0] + ojx; bby = B[b][1] + ojy; }
              }
        }
        if (bd >= padding * padding) continue;

        const dist = Math.sqrt(bd);
        const pen = padding - dist;
        if (pen > worst) worst = pen;
        hits++;
        const ux = dist < 1e-9 ? 1 : (bax - bbx) / dist;
        const uy = dist < 1e-9 ? 0 : (bay - bby) / dist;
        // split inversely to mass: the heavier body gives less ground
        const mi = groupMass(i), mj = groupMass(j);
        const wi = (mj / (mi + mj)) * pen * step;
        const wj = (mi / (mi + mj)) * pen * step;
        for (let m = 0; m < n; m++) {
          if (gid[i] >= 0 ? gid[m] === gid[i] : m === i) { pos[m][0] += ux * wi; pos[m][1] += uy * wi; }
          else if (gid[j] >= 0 ? gid[m] === gid[j] : m === j) { pos[m][0] -= ux * wj; pos[m][1] -= uy * wj; }
        }
      }

      /* Adjacency links. Neighbours in the real map are pulled toward each other;
       * the collision pass above is what stops them, so the pair settles at
       * contact rather than at some guessed distance. This is the difference
       * between compacting a map and compacting it *correctly*: gravity alone
       * pulls everything at a single point and does not care who borders whom,
       * so it closes gaps while quietly rearranging the neighbourhood.
       *
       * Mass-weighted the same way as collision, so a large state pulls a small
       * one to it rather than the two meeting halfway. Annealed for the same
       * reason as gravity -- attraction and collision are opposed. */
      const linkPull = linkStrength * Math.pow(linkDecay, it);
      if (links && linkPull > 1e-6) {
        for (let L = 0; L < links.length; L++) {
          const i = links[L][0], j = links[L][1], want = links[L][2];
          if (gid[i] >= 0 && gid[i] === gid[j]) continue;
          const dx = pos[j][0] - pos[i][0], dy = pos[j][1] - pos[i][1];
          const d = Math.hypot(dx, dy);
          if (d < 1e-9) continue;
          /* A spring to a target distance, not to zero. Pulling toward zero is
           * what a naive link force does and it collapses chains: a state with
           * eight neighbours gets eight full-strength pulls a pass. The target is
           * the pair's original centre spacing, scaled by how much the two
           * actually changed size -- if both halve, their centres should come
           * half as close. */
          const err = want ? (d - want) / d : 1;
          if (want && Math.abs(d - want) < 0.01) continue;
          const mi = groupMass(i), mj = groupMass(j);
          const si = (mj / (mi + mj)) * linkPull * err;
          const sj = (mi / (mi + mj)) * linkPull * err;
          for (let m = 0; m < n; m++) {
            if (gid[i] >= 0 ? gid[m] === gid[i] : m === i) { pos[m][0] += dx * si; pos[m][1] += dy * si; }
            else if (gid[j] >= 0 ? gid[m] === gid[j] : m === j) { pos[m][0] -= dx * sj; pos[m][1] -= dy * sj; }
          }
        }
      }

      /* Gravity: a pull toward the centre of mass, which closes the gaps the
       * collision pass opens. Note that p <- p + g(C - p) is (1-g)p + gC, a
       * uniform contraction about C -- so it compacts the map without distorting
       * the arrangement, which a per-pair attraction would.
       *
       * It is annealed, for the same reason d3-force decays alpha: gravity and
       * collision are opposed, so at constant strength the layout oscillates and
       * `worst` never settles under the tolerance. Decaying it means the early
       * iterations compact and the late ones are pure separation, so the run
       * still finishes on a layout that satisfies the padding. */
      let gx = 0, gy = 0;
      if (gravity > 0) {
        for (let m = 0; m < n; m++) { gx += pos[m][0]; gy += pos[m][1]; }
        gx /= n; gy /= n;
      }
      const pull = gravity * Math.pow(gravityDecay, it);

      for (let m = 0; m < n; m++) {
        if (pull > 1e-6) {
          pos[m][0] += pull * (gx - pos[m][0]);
          pos[m][1] += pull * (gy - pos[m][1]);
        }
        pos[m][0] += spring * (seed[m][0] - pos[m][0]);
        pos[m][1] += spring * (seed[m][1] - pos[m][1]);
        const dx = pos[m][0] - seed[m][0], dy = pos[m][1] - seed[m][1];
        const s = Math.hypot(dx, dy);
        if (s > maxShift) {
          pos[m][0] = seed[m][0] + (dx * maxShift) / s;
          pos[m][1] = seed[m][1] + (dy * maxShift) / s;
        }
      }
      // with gravity still active an empty pass is not yet an answer
      if ((!hits || worst < tol) && pull <= 1e-6 && linkPull <= 1e-6) break;
    }
    return {
      pos, iterations: it + 1, unmet: worst,
      converged: worst < tol,
      discCount: count,
      spacing,
      // true when the disc budget forced a coarser chain than padding/2
      coarsened: spacing > Math.max(padding / 2, 0.25) + 1e-9,
    };
  }

  // ------------------------------------------------------------- Hungarian ----

  /* O(n^3) shortest-augmenting-path assignment (Jonker-Volgenant), a direct
   * port of R/lib_assign.R. cost is a row-major n x m array, n <= m; returns the
   * column chosen for each row. */
  function hungarian(cost, n, m) {
    if (n > m) {                                   // solve the transpose
      const t = new Float64Array(n * m);
      for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) t[j * n + i] = cost[i * m + j];
      const b = hungarian(t, m, n);
      const a = new Int32Array(n);
      for (let j = 0; j < m; j++) a[b[j]] = j;
      return a;
    }
    const INF = Number.MAX_VALUE / 8;
    const u = new Float64Array(n + 1);
    const v = new Float64Array(m + 1);
    const p = new Int32Array(m + 1);
    const way = new Int32Array(m + 1);

    for (let i = 1; i <= n; i++) {
      p[0] = i;
      let j0 = 0;
      const minv = new Float64Array(m + 1).fill(INF);
      const used = new Uint8Array(m + 1);
      do {
        used[j0] = 1;
        const i0 = p[j0];
        let delta = INF, j1 = -1;
        for (let j = 1; j <= m; j++) {
          if (used[j]) continue;
          const cur = cost[(i0 - 1) * m + (j - 1)] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= m; j++) {
          if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
          else minv[j] -= delta;
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do {
        const j1 = way[j0];
        p[j0] = p[j1];
        j0 = j1;
      } while (j0);
    }
    const a = new Int32Array(n);
    for (let j = 1; j <= m; j++) if (p[j] > 0) a[p[j] - 1] = j - 1;
    return a;
  }

  // ------------------------------------------------------------ one state ----

  /* The whole subdivision for a single state: sample, cluster, balance, cells.
   *
   * k-means here is only a SEED for the balancer, which does its own Lloyd steps
   * -- so it is run briefly and on a subsample. Measured across all 50 states,
   * 60 full-sample iterations and 12 on a 4,000-point subsample give the same
   * median area ratio (1.03), and the short version is about half the time. The
   * quality ceiling is set by Monte-Carlo noise in the sample, not by k-means. */
  const CLUSTER_SUBSAMPLE = 4000;
  const CLUSTER_ITERS = 12;

  function carve(geom, k, opts) {
    opts = opts || {};
    const rand = mulberry32(opts.seed == null ? 1 : opts.seed);
    const pts = samplePoints(geom, opts.points || Math.max(1200, 400 * k), rand);
    if (k === 1) {
      const b = bbox(geom);
      const cx = new Float64Array([(b[0] + b[2]) / 2]);
      const cy = new Float64Array([(b[1] + b[3]) / 2]);
      return { pts, cx, cy, w: new Float64Array(1), cells: powerCells(cx, cy, null, b), err: 0 };
    }

    // evenly-strided subsample -- the points are already in random order, so a
    // stride is as good as a fresh draw and costs nothing
    const n = pts.length / 2;
    let cpts = pts;
    if (n > CLUSTER_SUBSAMPLE) {
      cpts = new Float64Array(CLUSTER_SUBSAMPLE * 2);
      const stride = n / CLUSTER_SUBSAMPLE;
      for (let i = 0; i < CLUSTER_SUBSAMPLE; i++) {
        const j = Math.floor(i * stride);
        cpts[i * 2] = pts[j * 2];
        cpts[i * 2 + 1] = pts[j * 2 + 1];
      }
    }
    const km = kmeans(cpts, k, rand, opts.clusterIters || CLUSTER_ITERS);
    const bal = opts.balance === false
      ? { cx: km.cx, cy: km.cy, w: new Float64Array(k), err: NaN }
      : balance(pts, km.cx.slice(), km.cy.slice(), opts.balanceIters || 60);
    return {
      pts, cx: bal.cx, cy: bal.cy, w: bal.w, err: bal.err,
      cells: powerCells(bal.cx, bal.cy, bal.w, bbox(geom)),
    };
  }

  // ----------------------------------------------------- custom geography ----

  /* Albers equal-area conic, fitted to the data.
   *
   * EQUAL-AREA is the requirement, not a preference: the whole cartogram scales
   * each region so that its drawn area is proportional to its seat count, which
   * is only meaningful if the source areas were themselves proportional to
   * ground area. A Mercator-projected input would silently inflate the north.
   *
   * Standard parallels at 1/6 and 5/6 of the latitude span is the usual
   * heuristic and is close to optimal for a compact region.
   *
   * This does NOT reproduce mapshaper's `albersusa` for the built-in map: that
   * one cuts Alaska and Hawaii out and insets them, which is an editorial
   * decision about the United States, not a projection. Custom geography is
   * drawn where it actually is. */
  function albersFit(lonLatBBox) {
    const [w, s, e, n] = lonLatBBox;
    const rad = Math.PI / 180;
    const lat0 = ((s + n) / 2) * rad, lon0 = ((w + e) / 2) * rad;
    const p1 = (s + (n - s) / 6) * rad, p2 = (s + (5 * (n - s)) / 6) * rad;
    const nn = Math.abs(p1 - p2) < 1e-9
      ? Math.sin(p1)
      : (Math.sin(p1) + Math.sin(p2)) / 2;
    const C = Math.cos(p1) * Math.cos(p1) + 2 * nn * Math.sin(p1);
    const rho = (phi) => Math.sqrt(Math.max(0, C - 2 * nn * Math.sin(phi))) / nn;
    const rho0 = rho(lat0);
    return (lon, lat) => {
      const th = nn * (lon * rad - lon0);
      const r = rho(lat * rad);
      // y negated: screen space runs downward, latitude runs up
      return [r * Math.sin(th), -(rho0 - r * Math.cos(th))];
    };
  }

  // ------------------------------------------------------ seats from CSV ----

  /* A delimited-text reader that handles the things real files actually have:
   * quoted fields with embedded delimiters, doubled quotes, CRLF, and a
   * delimiter that might be a comma, semicolon, tab or pipe. */
  function parseDelimited(text) {
    text = text.replace(/^﻿/, "");                       // strip a BOM
    const first = text.split(/\r?\n/).find((l) => l.trim()) || "";
    let delim = ",", best = -1;
    for (const d of [",", "\t", ";", "|"]) {
      // count only delimiters outside quotes
      let n = 0, q = false;
      for (const c of first) {
        if (c === '"') q = !q;
        else if (c === d && !q) n++;
      }
      if (n > best) { best = n; delim = d; }
    }

    const rows = [];
    let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else q = false;
        } else field += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows
      .map((r) => r.map((f) => f.trim()))
      .filter((r) => r.some((f) => f !== ""));
  }

  const SEAT_HEADERS = /^(seats?|districts?|n|num|number|count|cd|members?|reps?)$/i;

  /* Match a table of region -> seat count against a set of regions.
   *
   * Which column is which is decided by looking at the data rather than trusting
   * a header, because real files disagree about headers. The key column is
   * whichever one matches the most region names or codes; the value column is
   * whichever remaining one holds the most positive whole numbers, unless a
   * header explicitly names one. Comparison is case- and punctuation-insensitive
   * so "St. Louis", "st louis" and "ST-LOUIS" land together. */
  function seatsFromTable(rows, states, matchOn) {
    if (!rows.length) throw new Error("the file is empty");

    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

    /* `matchOn` names one property to key on -- FIPS, GEOID, a state code,
     * whatever the caller's table actually uses. Left unset it matches against
     * every field a region carries, which is what you want when you do not know
     * the file, and wrong when two fields collide (a numeric FIPS against a
     * numeric seat count, say). Naming the field removes the guess. */
    const lookup = new Map();
    const add = (v, id) => {
      const k = norm(v);
      if (k && !lookup.has(k)) lookup.set(k, id);
    };
    for (const s of states) {
      if (matchOn && matchOn !== "auto") {
        const v = s.props ? s.props[matchOn] : (matchOn === "st" ? s.st : s[matchOn]);
        if (v != null) add(v, s.st);
      } else {
        add(s.st, s.st);
        if (s.name) add(s.name, s.st);
        if (s.props) for (const k of Object.keys(s.props)) add(s.props[k], s.st);
      }
    }
    if (!lookup.size) throw new Error(`no region carries a “${matchOn}” value`);

    const ncol = Math.max(...rows.map((r) => r.length));
    const isNum = (v) => /^-?\d+(\.\d+)?$/.test(v) && Number(v) > 0;

    // does row 0 look like a header? -- it does if it names nothing we know
    const headerish = !rows[0].some((c) => lookup.has(norm(c)));
    const body = headerish && rows.length > 1 ? rows.slice(1) : rows;
    if (!body.length) throw new Error("no data rows");

    let keyCol = 0, keyHits = -1;
    for (let c = 0; c < ncol; c++) {
      let n = 0;
      for (const r of body) if (r[c] != null && lookup.has(norm(r[c]))) n++;
      if (n > keyHits) { keyHits = n; keyCol = c; }
    }

    let valCol = -1;
    if (headerish) {
      for (let c = 0; c < ncol; c++)
        if (c !== keyCol && SEAT_HEADERS.test(rows[0][c] || "")) { valCol = c; break; }
    }
    if (valCol < 0) {
      let bestNums = -1;
      for (let c = 0; c < ncol; c++) {
        if (c === keyCol) continue;
        let n = 0;
        for (const r of body) if (r[c] != null && isNum(r[c])) n++;
        if (n > bestNums) { bestNums = n; valCol = c; }
      }
    }
    if (valCol < 0) throw new Error("could not find a column of numbers");

    const table = {}, unmatched = [];
    let bad = 0;
    for (const r of body) {
      const id = lookup.get(norm(r[keyCol] || ""));
      const v = Number(r[valCol]);
      if (!id) { if ((r[keyCol] || "").trim()) unmatched.push(r[keyCol]); continue; }
      if (!Number.isFinite(v) || v < 1) { bad++; continue; }
      table[id] = Math.round(v);
    }

    const missing = states.filter((s) => table[s.st] == null).map((s) => s.st);
    return {
      table, unmatched, missing, bad,
      matched: Object.keys(table).length,
      keyCol, valCol, header: headerish ? rows[0] : null,
      total: Object.values(table).reduce((a, b) => a + b, 0),
    };
  }

  /* ---------------------------------------------------------- TopoJSON ----
   *
   * A TopoJSON topology stores each shared boundary once, as an "arc", and every
   * polygon as a list of arc indices. Decoding is three small steps and needs no
   * library:
   *
   *   1. arcs may be quantized -- integer deltas that accumulate from zero
   *      within each arc, then scale and translate back to real coordinates
   *   2. a negative index ~i means arc i traversed backwards, which is how the
   *      two polygons sharing a border each wind correctly
   *   3. a ring is its arcs concatenated, dropping each one's first point
   *      because it repeats the previous arc's last
   *
   * The point of the format is that a shared border is stored once and therefore
   * cannot disagree with itself -- which is exactly the property that matters
   * for a file of districts or states.
   */
  function decodeArc(arc, transform) {
    if (!transform) return arc.map((p) => [p[0], p[1]]);
    const [sx, sy] = transform.scale, [tx, ty] = transform.translate;
    let x = 0, y = 0;
    return arc.map((p) => {
      x += p[0]; y += p[1];
      return [x * sx + tx, y * sy + ty];
    });
  }

  function stitchRing(idxs, arcs) {
    const pts = [];
    for (const idx of idxs) {
      const rev = idx < 0;
      const a = arcs[rev ? ~idx : idx];
      if (!a) continue;
      const seq = rev ? a.slice().reverse() : a;
      for (let i = pts.length ? 1 : 0; i < seq.length; i++) pts.push(seq[i]);
    }
    if (pts.length > 2) {
      const a = pts[0], b = pts[pts.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) pts.push([a[0], a[1]]);
    }
    return pts;
  }

  /* Topology -> a plain GeoJSON FeatureCollection.
   *
   * A topology may hold several named objects (mapshaper writes one per input
   * layer). Without an explicit name, take the one with the most polygons and
   * report which, rather than silently picking the first. */
  function topologyToFeatures(topo, objectName) {
    if (!topo || !topo.objects) throw new Error("not a TopoJSON topology");
    const arcs = (topo.arcs || []).map((a) => decodeArc(a, topo.transform));

    const collect = (g, out, inherited) => {
      if (!g) return;
      const props = g.properties || inherited;
      if (g.type === "GeometryCollection") {
        for (const c of g.geometries || []) collect(c, out, props);
      } else if (g.type === "Polygon") {
        out.push({ type: "Feature", properties: props || {},
          geometry: { type: "Polygon", coordinates: (g.arcs || []).map((r) => stitchRing(r, arcs)) } });
      } else if (g.type === "MultiPolygon") {
        out.push({ type: "Feature", properties: props || {},
          geometry: { type: "MultiPolygon",
            coordinates: (g.arcs || []).map((p) => p.map((r) => stitchRing(r, arcs))) } });
      }
      // points and lines are not usable here and are dropped on purpose
    };

    const names = objectName ? [objectName] : Object.keys(topo.objects);
    let best = null;
    for (const n of names) {
      const feats = [];
      collect(topo.objects[n], feats, null);
      if (!best || feats.length > best.features.length) best = { name: n, features: feats };
    }
    if (!best || !best.features.length) throw new Error("no polygon features in the topology");

    return {
      type: "FeatureCollection",
      features: best.features,
      object: best.name,
      objectCount: Object.keys(topo.objects).length,
    };
  }

  /* Turn a GeoJSON FeatureCollection into the shape the studio solves.
   *
   * Coordinates are treated as longitude/latitude when they all fall inside
   * +/-180 by +/-90, and projected; anything else is assumed to be already in a
   * planar, equal-area space and only fitted to the frame. That test is a guess,
   * and a deliberately conservative one -- a projected file in metres or feet
   * cannot be mistaken for degrees, and the reverse would need a dataset
   * spanning less than 180 units, which the caller is told about. */
  function ingestGeoJSON(gj, opts) {
    opts = opts || {};
    const W = opts.width || 1152, H = opts.height || 748.8, pad = opts.pad == null ? 12 : opts.pad;

    // a topology is decoded to features first, then handled identically
    let topoInfo = null;
    if (gj && gj.type === "Topology") {
      const fc = topologyToFeatures(gj, opts.object);
      topoInfo = { object: fc.object, objectCount: fc.objectCount };
      gj = fc;
    }

    const feats = gj.type === "FeatureCollection" ? gj.features
      : gj.type === "Feature" ? [gj]
      : Array.isArray(gj) ? gj
      : gj.type === "GeometryCollection" ? gj.geometries.map((g) => ({ type: "Feature", geometry: g, properties: {} }))
      : [{ type: "Feature", geometry: gj, properties: {} }];

    const raw = [];
    for (const f of feats) {
      const g = f.geometry || f;
      if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
      raw.push({ props: f.properties || {}, parts: g.type === "Polygon" ? [g.coordinates] : g.coordinates });
    }
    if (!raw.length) throw new Error("no polygon features found");

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of raw) for (const p of r.parts) for (const ring of p) for (const c of ring) {
      if (c[0] < x0) x0 = c[0]; if (c[1] < y0) y0 = c[1];
      if (c[0] > x1) x1 = c[0]; if (c[1] > y1) y1 = c[1];
    }
    const looksLonLat = x0 >= -180.001 && x1 <= 180.001 && y0 >= -90.001 && y1 <= 90.001;
    const project = looksLonLat ? albersFit([x0, y0, x1, y1]) : null;

    const mapped = raw.map((r) => ({
      props: r.props,
      parts: r.parts.map((p) => p.map((ring) =>
        ring.map((c) => (project ? project(c[0], c[1]) : [c[0], c[1]])))),
    }));

    // fit to the frame with a single uniform scale, so relative areas survive
    x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity;
    for (const m of mapped) for (const p of m.parts) for (const ring of p) for (const c of ring) {
      if (c[0] < x0) x0 = c[0]; if (c[1] < y0) y0 = c[1];
      if (c[0] > x1) x1 = c[0]; if (c[1] > y1) y1 = c[1];
    }
    const k = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1));
    const ox = (W - (x1 - x0) * k) / 2 - x0 * k;
    const oy = (H - (y1 - y0) * k) / 2 - y0 * k;

    const NAME_KEYS = ["st", "STUSPS", "STATE_ABBR", "abbr", "code", "GEOID", "id", "name", "NAME", "NAMELSAD"];
    const SEAT_KEYS = ["seats", "SEATS", "districts", "DISTRICTS", "n_seats", "nseats"];
    const used = new Set();

    const out = mapped.map((m, i) => {
      const parts = m.parts.map((p) => p.map((ring) => {
        const r = ring.map((c) => [
          +(c[0] * k + ox).toFixed(2), +(c[1] * k + oy).toFixed(2)]);
        // rings must be closed for the area and crossing tests
        const a = r[0], b = r[r.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1]) r.push([a[0], a[1]]);
        return r;
      }));

      let key = null;
      for (const nk of NAME_KEYS) {
        const v = m.props[nk];
        if (v != null && String(v).trim()) { key = String(v).trim(); break; }
      }
      if (!key) key = "F" + (i + 1);
      // ids key the seat table and the clip paths, so they must be unique; they
      // are not truncated, because the label shown on the map is derived
      // separately and a lossy id would collide silently
      let id = key, n = 2;
      while (used.has(id)) id = key + " (" + n++ + ")";
      used.add(id);

      // keep the scalar properties: they are the fields a seat table may key on
      const props = {};
      for (const k of Object.keys(m.props || {})) {
        const v = m.props[k];
        if (v == null) continue;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          props[k] = String(v);
        }
      }

      let seats = 1;
      for (const sk of SEAT_KEYS) {
        const v = Number(m.props[sk]);
        if (Number.isFinite(v) && v >= 1) { seats = Math.round(v); break; }
      }

      const geom = parts;
      const b = bbox(geom);
      return {
        st: id,
        name: key,
        area: geomArea(geom),
        bbox: b,
        centroid: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2],
        props,
        seats: { custom: seats },
        outline: geom.length === 1
          ? { type: "Polygon", coordinates: geom[0] }
          : { type: "MultiPolygon", coordinates: geom },
        districts: [],
        slot: null, label: null, tweak: null, ref: null,
      };
    });

    return {
      states: out,
      projected: !!project,
      totalArea: out.reduce((a, s) => a + s.area, 0),
      dropped: raw.length - out.length,
      topology: topoInfo,
    };
  }

  return {
    mulberry32, ringArea2, partArea, geomArea, bbox,
    albersFit, ingestGeoJSON, topologyToFeatures,
    parseDelimited, seatsFromTable,
    pointInPart, pointInGeom, buildPIP, pipIndexed, samplePoints, kmeans,
    powerAssign, balance, clipBisector, powerCells,
    boundaryDiscs, adjacency, relaxDiscs, hungarian, carve,
  };
});
