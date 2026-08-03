/* studio.worker.js -- runs the solvers off the main thread.
 *
 * A full re-solve is 0.5-2 s depending on the sample size, which would freeze a
 * slider drag. The worker keeps the payload and a cell cache, so the two halves
 * of the problem can be re-run independently:
 *
 *   carving  depends on seat counts, sample size, seed, balancing
 *   placing  depends on the area divisor, padding, nudges, grouping
 *
 * Cells are computed in each state's own unscaled frame, so changing the scale
 * or the padding never invalidates them. That is what makes the padding slider
 * feel immediate.
 */

importScripts("solver.js");
const S = self.CartogramSolver;

let payload = null;
let cellCache = { key: null, value: null };
let adjCache = null;

/* Adjacency is derived once per geography from the ORIGINAL outlines, since that
 * is the only place the real borders are. Verified against facts: on the U.S.
 * states it finds 109 borders, gives Missouri and Tennessee eight neighbours
 * each (the maximum), Maine only New Hampshire, and Alaska and Hawaii none. */
function adjacencyOf() {
  if (adjCache) return adjCache;
  const t = performance.now();
  const a = S.adjacency(payload.states.map((s) => toGeom(s.outline)), 2);
  adjCache = { links: a.links, ms: Math.round(performance.now() - t) };
  return adjCache;
}

const toGeom = (g) =>
  g.type === "Polygon" ? [g.coordinates] : g.coordinates;

/* `custom` is a map of region id -> seat count, edited in the panel. It wins
 * whenever the seat source is "custom", which is also the only source available
 * for an uploaded geography -- a file has no apportionment history. */
function seatsFor(state, key, custom) {
  if (key === "custom") {
    const v = custom && custom[state.st];
    return Number.isFinite(v) && v >= 1 ? Math.round(v) : 1;
  }
  if (key === "districts") return state.districts.length;
  const v = state.seats && state.seats[key];
  return Number.isFinite(v) && v >= 1 ? v : 1;
}

/* ------------------------------------------------------------- carving ---- */

function carveAll(p, post) {
  const key = JSON.stringify([p.seatKey, p.cellMode, p.pointsPerSeat, p.seed, p.balanceIters,
    p.seatKey === "custom" ? p.customSeats : null, payload.geographyId || null]);
  if (cellCache.key === key) return cellCache.value;

  const t0 = performance.now();
  const out = [];
  let worstRatio = 0, worstSt = "";

  payload.states.forEach((s, i) => {
    const k = seatsFor(s, p.seatKey, p.customSeats);
    const geom = toGeom(s.outline);
    const r = S.carve(geom, k, {
      seed: p.seed + i,
      points: Math.max(600, p.pointsPerSeat * k),
      balance: p.cellMode === "balanced",
      balanceIters: p.balanceIters,
    });

    // the ratio the balancer is actually optimising, measured the same way
    let ratio = 1;
    if (k > 1) {
      const lab = new Int32Array(r.pts.length / 2);
      S.powerAssign(r.pts, r.cx, r.cy, r.w, lab);
      const cnt = new Array(k).fill(0);
      for (const l of lab) cnt[l]++;
      ratio = Math.max(...cnt) / Math.max(1, Math.min(...cnt));
    }
    if (ratio > worstRatio) { worstRatio = ratio; worstSt = s.st; }

    out.push({ st: s.st, k, cells: r.cells, sites: { cx: Array.from(r.cx), cy: Array.from(r.cy) } });
    if (i % 6 === 0) post(Math.round((i / payload.states.length) * 100), "carving " + s.st);
  });

  cellCache = {
    key,
    value: { states: out, ms: Math.round(performance.now() - t0), worstRatio, worstSt },
  };
  return cellCache.value;
}

/* ------------------------------------------------------------- placing ---- */

function place(p) {
  const t0 = performance.now();
  const total = payload.totalArea;
  const allSeats = payload.states.reduce((a, s) => a + seatsFor(s, p.seatKey, p.customSeats), 0);
  const dw = payload.design.w, dh = payload.design.h;
  const W = payload.design.width, H = payload.design.height;
  // the tweaks are authored in design units on a 0.65 aspect; same conversion R uses
  const yScale = dh / (dw * 0.65);
  /* "free" is now a mode the reader can choose, not only the fallback: it is
   * what the soft-body layout used to offer -- a placement that needs no
   * hand-drawn slots -- but reached by moving rigid states rather than by
   * bending them. */
  const hasSlots = p.placement !== "free"
    && !payload.uploaded && payload.states.every((s) => s.slot);

  let mx = 0, my = 0;
  for (const s of payload.states) { mx += s.centroid[0]; my += s.centroid[1]; }
  mx /= payload.states.length; my /= payload.states.length;

  const scaleOf = (s) => {
    const k = seatsFor(s, p.seatKey, p.customSeats);
    return Math.sqrt((total * (k / allSeats)) / s.area / p.areaDivisor);
  };

  /* Two ways to seed a region.
   *
   * `slots` uses the hand-drawn Figma layout -- one authored rectangle per
   * state, which is the top-left the scaled bounding box moves to. It is by far
   * the nicest result, because a person placed every state.
   *
   * `free` pins each region at its own centroid and expands the arrangement as a
   * whole by `expand`. That is the only option for an uploaded file, and it is
   * also the fallback when the slots stop working -- which they do as soon as
   * the seat counts stray far from the ones they were drawn for. Give every
   * state two seats and Wyoming needs six times the room its slot allows. */
  function makeBodies(mode, expand) {
    return payload.states.map((s) => {
      const scale = scaleOf(s);
      const geom = toGeom(s.outline).map((part) =>
        part.map((ring) => ring.map((c) => [c[0] * scale, c[1] * scale])));

      let x, y;
      if (mode === "slots") {
        let sx = (s.slot[0] / dw) * W, sy = (s.slot[1] / dh) * H;
        if (p.tweaks && s.tweak) {
          sx += (s.tweak[0] / dw) * W;
          sy += (s.tweak[1] / dh) * H * yScale;
        }
        x = sx - s.bbox[0] * scale;
        y = sy - s.bbox[1] * scale;
      } else {
        x = mx + (s.centroid[0] - mx) * expand - s.centroid[0] * scale;
        y = my + (s.centroid[1] - my) * expand - s.centroid[1] * scale;
      }

      return {
        st: s.st, geom, scale, x, y,
        group: mode === "slots" && p.groupNE && payload.newEngland &&
               payload.newEngland.includes(s.st) ? 1 : null,
      };
    });
  }

  const noRelax = (bodies) => ({
    pos: bodies.map((b) => [b.x, b.y]), iterations: 0, unmet: 0, converged: true,
    discCount: 0, spacing: 0, coarsened: false,
  });

  // the cap keeps a state near the slot a person drew for it; scale it with the
  // state size, since that is a control here and R only ever ran at one size
  const slotShift = 40 * Math.sqrt(payload.defaults.areaDivisor / p.areaDivisor);

  let bodies = null, res = null, mode = "slots", expand = 1, solves = 0;

  if (hasSlots) {
    bodies = makeBodies("slots", 1);
    res = p.padding > 0
      ? S.relaxDiscs(bodies, p.padding, { maxIter: p.maxIter || 300, maxShift: slotShift })
      : noRelax(bodies);
    solves = 1;
  }

  /* Fall back to the free layout when the slots cannot be made to work. The old
   * behaviour was to return the unconverged slot layout, which is what "it
   * mangled the states" looks like: states left overlapping because the cap
   * would not let them move far enough to escape. */
  if (!hasSlots || !res.converged) {
    mode = "free";
    const gravity = p.gravity == null ? 0.01 : p.gravity;
    const linkStrength = p.linkStrength || 0;

    /* Neighbours are sprung to a target distance, not to contact: their original
     * centre spacing, scaled by how much the pair actually resized. If both
     * halve, their centres should come half as close. Springing to zero instead
     * is what a naive link force does, and it collapses chains -- a state with
     * eight neighbours takes eight full-strength pulls a pass. */
    let links = null;
    if (linkStrength > 0) {
      const sc = payload.states.map(scaleOf);
      links = adjacencyOf().links.map(([i, j]) => {
        const a = payload.states[i].centroid, b = payload.states[j].centroid;
        const d0 = Math.hypot(a[0] - b[0], a[1] - b[1]);
        return [i, j, d0 * (sc[i] + sc[j]) / 2];
      });
    }
    /* linkDecay is slower than gravity's: the links have to undo the initial
     * spread, which takes longer than gravity needs to simply tighten. */
    const opts = {
      maxIter: 900, maxShift: 1e6, spring: 0,
      gravity, links, linkStrength, linkDecay: 0.995,
    };
    const run = (e) => {
      solves++;
      const bs = makeBodies("free", e);
      return { bs, r: p.padding > 0 ? S.relaxDiscs(bs, p.padding, opts) : noRelax(bs) };
    };

    /* Start from the largest region growth, since that is what has to be made
     * room for, and escalate until it solves. Then bisect DOWNWARD: the first
     * expansion that works is rarely the tightest, and a looser arrangement
     * refits to a smaller map. On the U.S. states this takes the packing from
     * 7.3% of the bounding box to 15.9%; at two seats each, 1.0% to 6.5%. */
    let hi = Math.max(1, ...makeBodies("free", 1).map((b) => b.scale));
    let lo = 1, out = run(hi), tries = 0;
    while (!out.r.converged && tries++ < 6) { lo = hi; hi *= 1.4; out = run(hi); }
    if (out.r.converged) {
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) / 2;
        const t = run(mid);
        if (t.r.converged) { hi = mid; out = t; } else lo = mid;
      }
    }
    expand = hi;
    bodies = out.bs;
    res = out.r;
  }

  const seeded = bodies.map((b) => ({ st: b.st, x: b.x, y: b.y }));
  let out = bodies.map((b, i) => ({
    st: b.st, scale: b.scale, tx: res.pos[i][0], ty: res.pos[i][1],
    seedTx: seeded[i].x, seedTy: seeded[i].y,
  }));

  /* A free layout is solved expanded, so fit it back to the frame. The refit
   * composes exactly: a body is drawn as p*scale + t, so a global u -> g*u + d
   * makes the scale scale*g and the offset g*t + d. Nothing is re-solved, and
   * relative areas -- the only thing the cartogram claims -- are untouched. */
  let fit = 1;
  if (mode === "free") {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    bodies.forEach((b, i) => {
      const bb = S.bbox(b.geom);
      x0 = Math.min(x0, bb[0] + res.pos[i][0]); y0 = Math.min(y0, bb[1] + res.pos[i][1]);
      x1 = Math.max(x1, bb[2] + res.pos[i][0]); y1 = Math.max(y1, bb[3] + res.pos[i][1]);
    });
    const pad = 10;
    fit = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1));
    const dx = (W - (x1 - x0) * fit) / 2 - x0 * fit;
    const dy = (H - (y1 - y0) * fit) / 2 - y0 * fit;
    out = out.map((b) => ({
      st: b.st, scale: b.scale * fit,
      tx: b.tx * fit + dx, ty: b.ty * fit + dy,
      seedTx: b.seedTx * fit + dx, seedTy: b.seedTy * fit + dy,
    }));
  }

  /* How faithful the arrangement is, independent of overall zoom -- the layout
   * is refitted anyway, so only relative spacing means anything. Fit the best
   * uniform scale by least squares, then report the mean residual. */
  let fidelity = null;
  if (payload.states.length > 1 && payload.states[0].centroid) {
    const sc = payload.states.map(scaleOf);
    const ls = adjacencyOf().links;
    if (ls.length) {
      let num = 0, den = 0;
      const want = [], got = [];
      for (const [i, j] of ls) {
        const a = payload.states[i].centroid, b = payload.states[j].centroid;
        const w = Math.hypot(a[0] - b[0], a[1] - b[1]) * (sc[i] + sc[j]) / 2;
        const d = Math.hypot(out[i].tx - out[j].tx, out[i].ty - out[j].ty);
        want.push(w); got.push(d); num += d * w; den += d * d;
      }
      const lam = den > 0 ? num / den : 1;
      let e = 0;
      for (let k = 0; k < want.length; k++) e += Math.abs(lam * got[k] - want[k]) / want[k];
      fidelity = { error: (100 * e) / want.length, borders: ls.length, ms: adjacencyOf().ms };
    }
  }

  const cap = mode === "slots" ? slotShift : 1e6;
  return {
    bodies: out,
    stats: {
      ms: Math.round(performance.now() - t0),
      iterations: res.iterations, unmet: res.unmet, converged: res.converged,
      discCount: res.discCount, spacing: res.spacing, coarsened: res.coarsened,
      mode, expand: mode === "free" ? expand : null, solves, fidelity,
      maxShift: cap,
      effectivePadding: p.padding * fit,
      moved: res.pos.reduce((a, q, i) =>
        Math.max(a, Math.hypot(q[0] - seeded[i].x, q[1] - seeded[i].y)), 0),
      atCap: res.pos.reduce((a, q, i) =>
        a + (Math.hypot(q[0] - seeded[i].x, q[1] - seeded[i].y) > cap * 0.98 ? 1 : 0), 0),
    },
  };
}

/* ---------------------------------------------------------- assignment ---- */

/* Match this run's cells to the 2022 districts by minimum total squared
 * distance, so the map can be coloured by who actually won. Only meaningful
 * when the cell count is the district count. */
function assign(carved) {
  const t0 = performance.now();
  let cost = 0;
  const out = {};
  for (const s of payload.states) {
    const c = carved.states.find((q) => q.st === s.st);
    const n = s.districts.length, m = c.k;
    if (n !== m) { out[s.st] = null; continue; }
    const M = new Float64Array(n * m);
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
      const dx = s.districts[i].c[0] - c.sites.cx[j];
      const dy = s.districts[i].c[1] - c.sites.cy[j];
      M[i * m + j] = dx * dx + dy * dy;
    }
    const a = S.hungarian(M, n, m);
    const byCell = new Array(m).fill(null);
    for (let i = 0; i < n; i++) { byCell[a[i]] = s.districts[i]; cost += M[i * m + a[i]]; }
    out[s.st] = byCell;
  }
  return { byState: out, cost, ms: Math.round(performance.now() - t0) };
}

/* --------------------------------------------------------------- driver ---- */

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === "init") {
    payload = msg.payload;
    adjCache = null;
    self.postMessage({ type: "ready", states: payload.states.length });
    return;
  }

  if (msg.type === "solve") {
    const p = msg.params;
    const post = (pct, label) =>
      self.postMessage({ type: "progress", id: msg.id, pct, label });

    try {
      let carved = null, matched = null;
      if (p.cellMode !== "none") {
        carved = carveAll(p, post);
        post(100, "matching");
        if (p.colourBy === "party" && p.seatKey === "districts") matched = assign(carved);
      }
      post(100, "placing");

      const placed = place(p);

      self.postMessage({
        type: "done",
        id: msg.id,
        result: {
          bodies: placed.bodies,
          place: placed.stats,
          cells: carved
            ? { states: carved.states.map((c) => ({ st: c.st, k: c.k, cells: c.cells })),
                ms: carved.ms, worstRatio: carved.worstRatio, worstSt: carved.worstSt,
                cached: cellCache.key !== null && carved === cellCache.value }
            : null,
          match: matched
            ? { byState: matched.byState, cost: matched.cost, ms: matched.ms }
            : null,
        },
      });
    } catch (err) {
      self.postMessage({ type: "error", id: msg.id, message: String(err && err.message || err) });
    }
  }
};
