/* studio.js -- controls, worker plumbing, and SVG rendering.
 *
 * The solving happens in studio.worker.js. This file collects parameters,
 * debounces them, and paints the result.
 *
 * The rendering trick worth knowing: cells are the raw convex polygons, and the
 * state outline is used as an SVG <clipPath> around them. So the browser does
 * the clipping mapshaper does in the R build, at paint time, and no polygon
 * library is needed. Because the clip path lives inside the state's transformed
 * group, its coordinates are the state's own unscaled ones -- the same path data
 * as the outline.
 */
(function () {
  "use strict";

  const root = document.getElementById("cs-root");
  if (!root) return;

  const $ = (id) => document.getElementById(id);
  const map = $("cs-map");
  const SVG = "http://www.w3.org/2000/svg";

  const el = {
    seats: $("cs-seats"), divisor: $("cs-divisor"), divisorOut: $("cs-divisor-out"),
    padding: $("cs-padding"), paddingOut: $("cs-padding-out"),
    tweaks: $("cs-tweaks"), groupNE: $("cs-group-ne"), ghost: $("cs-ghost"),
    cells: $("cs-cells"), colour: $("cs-colour"),
    points: $("cs-points"), pointsOut: $("cs-points-out"),
    seed: $("cs-seed"), reroll: $("cs-reroll"),
    geoFile: $("cs-geo-file"), geoNote: $("cs-geo-note"),
    geoCurrent: $("cs-geo-current"), geoLoad: $("cs-geo-load"), geoClear: $("cs-geo-clear"),
    seatsLoad: $("cs-seats-load"), seatsFile: $("cs-seats-file"), seatsNote: $("cs-seats-note"),
    matchOn: $("cs-match-on"), seatTwo: $("cs-seat-two"),
    gravity: $("cs-gravity"), gravityOut: $("cs-gravity-out"), modeOut: $("cs-mode-out"),
    links: $("cs-links"), linksOut: $("cs-links-out"),
    placement: $("cs-placement"), softNote: $("cs-soft-note"),
    seatEditor: $("cs-seat-editor"), seatGrid: $("cs-seat-grid"),
    seatTotal: $("cs-seat-total"), seatCopy: $("cs-seat-copy"), seatOne: $("cs-seat-one"),
    solve: $("cs-solve"), auto: $("cs-auto"), reset: $("cs-reset"),
    progress: $("cs-progress"), fill: $("cs-progress-fill"), plabel: $("cs-progress-label"),
    statPlace: $("cs-stat-place"), statCells: $("cs-stat-cells"),
    statMatch: $("cs-stat-match"), statRef: $("cs-stat-ref"), statAdj: $("cs-stat-adj"),
    warn: $("cs-warn"),
  };

  const GEO_NOTE =
    "GeoJSON or TopoJSON, any polygon layer — or just drop a file on the map. " +
    "Longitude/latitude is detected and projected equal-area; already-projected " +
    "files are used as they are.";
  const SEATS_NOTE =
    "Two columns: a region name or code, and a number. A header is optional. " +
    "Matched by code or name, so CA,52 and California,52 both work.";
  const resetGeoNote = () => { el.geoNote.textContent = GEO_NOTE; };

  let payload = null, worker = null, seq = 0, pending = null, busy = false;
  let builtin = null;            // the shipped U.S. payload, kept for "go back"
  let customSeats = {};          // region id -> seat count, when the source is custom

  const DEFAULTS = {
    seats: "districts", divisor: 2.9, padding: 2, tweaks: true, groupNE: true,
    cells: "balanced", colour: true, points: 200, seed: 20221108, ghost: false,
    gravity: 0.005, links: 0.05,
  };

  /* Offer every field the loaded regions actually carry, so a table keyed on
   * FIPS or GEOID can say so. Matching against all fields at once is the right
   * default but can go wrong when two fields collide -- a numeric FIPS column
   * against a numeric seat count, say -- and naming the field removes the guess. */
  function buildMatchOptions() {
    const keys = new Set();
    for (const s of payload.states)
      if (s.props) for (const k of Object.keys(s.props)) keys.add(k);
    const prev = el.matchOn.value;
    el.matchOn.textContent = "";
    const add = (v, label) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = label;
      el.matchOn.appendChild(o);
    };
    add("auto", "any field");
    for (const k of [...keys].sort()) add(k, k);
    el.matchOn.value = [...el.matchOn.options].some((o) => o.value === prev) ? prev : "auto";
  }

  /* ------------------------------------------------------------ params ---- */

  function params() {
    return {
      seatKey: el.seats.value,
      areaDivisor: +el.divisor.value,
      padding: +el.padding.value,
      tweaks: el.tweaks.checked,
      groupNE: el.groupNE.checked,
      cellMode: el.cells.value,
      colourBy: el.colour.checked ? "party" : "none",
      pointsPerSeat: +el.points.value,
      seed: +el.seed.value | 0,
      balanceIters: payload ? payload.defaults.balanceIters : 40,
      customSeats: el.seats.value === "custom" ? customSeats : null,
      gravity: +el.gravity.value,
      linkStrength: +el.links.value,
      placement: el.placement.value,
      neighbour: 1.2,
    };
  }

  function syncOutputs() {
    el.divisorOut.textContent = (+el.divisor.value).toFixed(2);
    el.paddingOut.textContent = (+el.padding.value).toFixed(1) + " px";
    el.pointsOut.textContent = el.points.value;
    el.gravityOut.textContent = (+el.gravity.value).toFixed(3);
    el.linksOut.textContent = (+el.links.value).toFixed(2);

    const uploaded = !!(payload && payload.uploaded);

    // colouring by winner only means anything when the cells ARE the 2022
    // districts, which an uploaded file never is
    const canColour = !uploaded && el.seats.value === "districts" && el.cells.value !== "none";
    el.colour.disabled = !canColour;
    el.colour.parentElement.style.opacity = canColour ? "" : "0.5";

    // the hand-drawn slots, the New England grouping and the nudges are all
    // facts about the built-in U.S. map
    for (const c of [el.tweaks, el.groupNE, el.ghost]) {
      c.disabled = uploaded;
      c.parentElement.style.opacity = uploaded ? "0.5" : "";
    }

    const soft = el.placement.value === "soft";
    el.softNote.hidden = !soft;
    for (const c of [el.gravity, el.links, el.ghost])
      c.disabled = soft || (c === el.ghost && uploaded);

    el.seatEditor.hidden = el.seats.value !== "custom";
    if (el.seats.value === "custom") updateSeatTotal();
  }

  /* -------------------------------------------------------- seat editor ---- */

  // what a given source would give each region, used to seed the custom table
  function seatsFromSource(key) {
    const out = {};
    for (const s of payload.states) {
      out[s.st] = key === "custom" ? (customSeats[s.st] || 1)
        : key === "districts" ? (s.districts ? s.districts.length : 1)
        : (s.seats && s.seats[key]) || 1;
    }
    return out;
  }

  function buildSeatGrid() {
    el.seatGrid.textContent = "";
    for (const s of payload.states) {
      const row = document.createElement("label");
      row.className = "cs-seat-row";
      const name = document.createElement("span");
      name.textContent = s.st;
      name.title = s.name || s.st;
      const inp = document.createElement("input");
      inp.type = "number";
      inp.min = "1";
      inp.step = "1";
      inp.value = customSeats[s.st] || 1;
      inp.dataset.st = s.st;
      inp.addEventListener("input", () => {
        const v = Math.max(1, Math.round(+inp.value || 1));
        customSeats[s.st] = v;
        updateSeatTotal();
        schedule(400);
      });
      row.appendChild(name);
      row.appendChild(inp);
      el.seatGrid.appendChild(row);
    }
    updateSeatTotal();
  }

  function updateSeatTotal() {
    let t = 0;
    for (const s of payload.states) t += customSeats[s.st] || 1;
    el.seatTotal.textContent = t.toLocaleString();
  }

  function setSeats(table) {
    customSeats = table;
    for (const inp of el.seatGrid.querySelectorAll("input"))
      inp.value = customSeats[inp.dataset.st] || 1;
    updateSeatTotal();
  }

  /* ------------------------------------------------------------ worker ---- */

  function start(data) {
    builtin = data;
    payload = data;
    customSeats = seatsFromSource("districts");
    buildSeatGrid();
    buildMatchOptions();
    syncOutputs();
    startWorker();
  }

  function startWorker() {
    worker = new Worker(root.dataset.worker);
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") { solve(); return; }
      if (m.type === "progress") {
        el.fill.style.width = m.pct + "%";
        el.plabel.textContent = m.label;
        return;
      }
      if (m.type === "error") {
        busy = false;
        showOverlay(false);
        el.solve.disabled = false;
        warn("The solver failed: " + m.message);
        return;
      }
      if (m.type === "done") {
        busy = false;
        showOverlay(false);
        el.solve.disabled = false;
        render(m.result);
        if (pending) { const p = pending; pending = null; dispatch(p); }
      }
    };
    worker.onerror = (e) => {
      busy = false;
      showOverlay(false);
      el.solve.disabled = false;
      warn("The solver could not start: " + (e.message || "worker error"));
    };
    worker.postMessage({ type: "init", payload });
  }

  /* Placement alone re-solves in well under a tenth of a second, so showing the
   * overlay immediately would make dragging a slider strobe. Hold it back a
   * moment: a re-place never shows it, a re-carve always does. */
  let overlayTimer = null;
  function showOverlay(on) {
    clearTimeout(overlayTimer);
    if (on) overlayTimer = setTimeout(() => { el.progress.hidden = false; }, 250);
    else el.progress.hidden = true;
  }

  // says out loud that what is on screen is not what the controls now describe
  function markStale(on) {
    el.solve.textContent = on ? "Re-solve (settings changed)" : "Re-solve";
    el.solve.classList.toggle("cs-btn-stale", on);
  }

  function dispatch(p) {
    markStale(false);
    busy = true;
    el.solve.disabled = true;
    el.fill.style.width = "0%";
    el.plabel.textContent = "solving…";
    showOverlay(true);
    worker.postMessage({ type: "solve", id: ++seq, params: p });
  }

  function solve() {
    if (!worker) return;
    const p = params();
    if (busy) { pending = p; return; }   // coalesce: only the latest matters
    dispatch(p);
  }

  let timer = null;
  const schedule = (ms) => {
    syncOutputs();
    // the soft layout costs seconds, so it never runs off a slider -- only when
    // Re-solve is pressed, which is what the mode note promises
    if (el.placement.value === "soft") { markStale(true); return; }
    if (!el.auto.checked) return;
    clearTimeout(timer);
    timer = setTimeout(solve, ms);
  };

  /* ------------------------------------------------------------ render ---- */

  const path = (rings) => {
    let d = "";
    for (const ring of rings) {
      if (!ring || ring.length < 3) continue;
      d += "M" + ring.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L") + "Z";
    }
    return d;
  };
  const geomPath = (g) =>
    path(g.type === "Polygon" ? g.coordinates : g.coordinates.flat());

  function render(res) {
    if (res.soft) return renderSoft(res);
    const frag = document.createDocumentFragment();
    const defs = document.createElementNS(SVG, "defs");
    const byState = {};
    for (const s of payload.states) byState[s.st] = s;
    const cellsBySt = {};
    if (res.cells) for (const c of res.cells.states) cellsBySt[c.st] = c;
    const palette = payload.palette;

    // ghost of the R build, underneath -- only the built-in map has one
    if (el.ghost.checked && !payload.uploaded) {
      const g = document.createElementNS(SVG, "g");
      for (const s of payload.states) {
        const p = document.createElementNS(SVG, "path");
        p.setAttribute("class", "cs-ghost-path");
        p.setAttribute("d", geomPath(s.outline));
        p.setAttribute("transform",
          `translate(${s.ref.tx.toFixed(2)},${s.ref.ty.toFixed(2)}) scale(${s.ref.scale.toFixed(5)})`);
        g.appendChild(p);
      }
      frag.appendChild(g);
    }

    for (const b of res.bodies) {
      const s = byState[b.st];
      const d = geomPath(s.outline);
      const g = document.createElementNS(SVG, "g");
      g.setAttribute("transform",
        `translate(${b.tx.toFixed(2)},${b.ty.toFixed(2)}) scale(${b.scale.toFixed(5)})`);

      const carved = cellsBySt[b.st];
      if (carved) {
        g.setAttribute("class", "cs-has-cells");

        // the browser does mapshaper's job: clip the cells with the outline
        const cp = document.createElementNS(SVG, "clipPath");
        cp.setAttribute("id", "cs-clip-" + b.st);
        const cpp = document.createElementNS(SVG, "path");
        cpp.setAttribute("d", d);
        cp.appendChild(cpp);
        defs.appendChild(cp);

        const inner = document.createElementNS(SVG, "g");
        inner.setAttribute("clip-path", "url(#cs-clip-" + b.st + ")");
        const match = res.match && res.match.byState[b.st];
        carved.cells.forEach((cell, i) => {
          if (!cell || cell.length < 3) return;
          const p = document.createElementNS(SVG, "path");
          p.setAttribute("class", "cs-cell");
          p.setAttribute("d", path([cell]));
          const dist = match && match[i];
          p.setAttribute("fill", dist ? (palette[dist.p] || palette.Other) : "var(--cs-state)");
          if (dist) {
            const t = document.createElementNS(SVG, "title");
            t.textContent = dist.id + " — " + dist.p;
            p.appendChild(t);
          }
          inner.appendChild(p);
        });
        g.appendChild(inner);

        // the outline again on top, so the border reads crisply over the cells
        const hull = document.createElementNS(SVG, "path");
        hull.setAttribute("class", "cs-hull");
        hull.setAttribute("d", d);
        g.appendChild(hull);
      } else {
        const p = document.createElementNS(SVG, "path");
        p.setAttribute("class", "cs-outline-path");
        p.setAttribute("d", d);
        g.appendChild(p);
      }

      frag.appendChild(g);
    }

    /* State labels. The hand-drawn anchors are positions in the Figma layout, so
     * they only mean anything when the states are in their slots -- in gravity
     * mode they would float in empty space. Fall back to the region's own centre. */
    const freeMode = res.place && res.place.mode === "free";
    const labels = document.createElementNS(SVG, "g");
    const dw = payload.design.w, dh = payload.design.h;
    const W = payload.design.width, H = payload.design.height;
    for (const b of res.bodies) {
      const s = byState[b.st];
      const t = document.createElementNS(SVG, "text");
      t.setAttribute("class", "cs-lab");
      if (s.label && !freeMode) {
        // the hand-placed label rides with however far the state actually moved
        t.setAttribute("x", ((s.label[0] / dw) * W + (b.tx - b.seedTx)).toFixed(1));
        t.setAttribute("y", ((s.label[1] / dh) * H + (b.ty - b.seedTy)).toFixed(1));
      } else {
        // uploaded geography: put it at the region's own centre, transformed
        t.setAttribute("x", (s.centroid[0] * b.scale + b.tx).toFixed(1));
        t.setAttribute("y", (s.centroid[1] * b.scale + b.ty).toFixed(1));
      }
      // built-in ids are already two-letter postal codes; an uploaded file's are
      // whole region names, which have to be cut down to sit on the map
      if (s.st.length > 9) {
        t.textContent = s.st.slice(0, 8) + "…";
        const full = document.createElementNS(SVG, "title");
        full.textContent = s.st;
        t.appendChild(full);
      } else {
        t.textContent = s.st;
      }
      labels.appendChild(t);
    }
    frag.appendChild(labels);

    map.textContent = "";
    map.appendChild(defs);
    map.appendChild(frag);

    stats(res);
  }

  /* The soft layout returns deformed OUTLINES rather than a transform, so this
   * draws the geometry straight rather than putting a raw outline inside a
   * transformed group. The clipPath trick still applies: cells are deformed by
   * the same field, and the outline clips them. */
  function renderSoft(res) {
    const frag = document.createDocumentFragment();
    const defs = document.createElementNS(SVG, "defs");
    const palette = payload.palette;
    const match = res.match && res.match.byState;
    const cells = res.soft.cells;

    res.soft.outlines.forEach((geom, i) => {
      const st = payload.states[i];
      const d = path(geom.flat());
      const g = document.createElementNS(SVG, "g");
      const mine = cells && cells[i];

      if (mine) {
        const cp = document.createElementNS(SVG, "clipPath");
        cp.setAttribute("id", "cs-soft-" + i);
        const cpp = document.createElementNS(SVG, "path");
        cpp.setAttribute("d", d);
        cp.appendChild(cpp);
        defs.appendChild(cp);

        const inner = document.createElementNS(SVG, "g");
        inner.setAttribute("clip-path", "url(#cs-soft-" + i + ")");
        const pair = match && match[st.st];
        mine.cells.forEach((cell, k) => {
          if (!cell) return;
          const q = document.createElementNS(SVG, "path");
          q.setAttribute("class", "cs-cell");
          q.setAttribute("d", path([cell]));
          const dist = pair && pair[k];
          q.setAttribute("fill", dist ? (palette[dist.p] || palette.Other) : "var(--cs-state)");
          if (dist) {
            const ttl = document.createElementNS(SVG, "title");
            ttl.textContent = dist.id + " — " + dist.p;
            q.appendChild(ttl);
          }
          inner.appendChild(q);
        });
        g.appendChild(inner);

        const hull = document.createElementNS(SVG, "path");
        hull.setAttribute("class", "cs-hull");
        hull.setAttribute("d", d);
        g.appendChild(hull);
      } else {
        const q = document.createElementNS(SVG, "path");
        q.setAttribute("class", "cs-outline-path");
        q.setAttribute("d", d);
        g.appendChild(q);
      }
      frag.appendChild(g);
    });

    const labels = document.createElementNS(SVG, "g");
    res.soft.centres.forEach((c, i) => {
      const t = document.createElementNS(SVG, "text");
      t.setAttribute("class", "cs-lab");
      t.setAttribute("x", c[0]); t.setAttribute("y", c[1]);
      t.textContent = payload.states[i].st;
      labels.appendChild(t);
    });
    frag.appendChild(labels);

    map.textContent = "";
    map.appendChild(defs);
    map.appendChild(frag);
    stats(res);
  }

  function stats(res) {
    const p = res.place;
    if (p.mode === "soft") {
      el.modeOut.textContent = "soft body";
      el.statPlace.textContent =
        `${p.circles.toLocaleString()} circles, ${p.iterations} iterations, ` +
        `${(p.ms / 1000).toFixed(1)} s`;
      el.statAdj.textContent = `${p.borders} borders · ${p.anchors} segment anchors`;
      el.statCells.textContent = res.cells
        ? `carved, deformed with the outlines · worst area ratio ${res.cells.worstRatio.toFixed(2)} (${res.cells.worstSt})`
        : "off";
      el.statMatch.textContent = res.match
        ? `${res.match.ms} ms · total cost ${Math.round(res.match.cost).toLocaleString()} px²`
        : "—";
      el.statRef.textContent = "n/a — no hand-drawn layout used";
      warn("");
      return;
    }
    el.statPlace.textContent = p.iterations === 0
      ? "no relaxation (padding 0)"
      : `${p.iterations} iterations, ${p.ms} ms · ` +
        `${p.discCount.toLocaleString()} discs · worst region moved ${p.moved.toFixed(1)} px` +
        (p.expand ? ` · spread ${p.expand.toFixed(2)}× over ${p.solves} solves, refitted` : "");
    el.modeOut.textContent = p.mode === "slots" ? "hand-drawn slots" : "force layout";

    if (res.cells) {
      const c = res.cells;
      const n = c.states.reduce((a, s) => a + s.k, 0);
      el.statCells.textContent =
        `${n} cells, ${c.ms} ms · worst area ratio ${c.worstRatio.toFixed(2)} (${c.worstSt})`;
    } else {
      el.statCells.textContent = "off";
    }

    /* How faithful the arrangement is. Zoom-invariant, since the layout is
     * refitted anyway -- it is the mean deviation of neighbour spacing from what
     * the real geography implies, after fitting the best uniform scale. */
    el.statAdj.textContent = p.fidelity
      ? `${p.fidelity.borders} borders · spacing off by ${p.fidelity.error.toFixed(0)}%`
      : "—";

    el.statMatch.textContent = res.match
      ? `${res.match.ms} ms · total cost ${Math.round(res.match.cost).toLocaleString()} px²`
      : "—";

    // how far this solve sits from the layout R shipped -- only comparable for
    // the built-in map, which is the only thing R ever built
    if (payload.uploaded) {
      el.statRef.textContent = "n/a — uploaded geography";
    } else {
      let worst = 0, worstSt = "", mean = 0;
      for (const b of res.bodies) {
        const s = payload.states.find((q) => q.st === b.st);
        const d = Math.hypot(b.tx - s.ref.tx, b.ty - s.ref.ty);
        mean += d;
        if (d > worst) { worst = d; worstSt = b.st; }
      }
      mean /= res.bodies.length;
      el.statRef.textContent =
        `mean ${mean.toFixed(1)} px, worst ${worst.toFixed(1)} px (${worstSt})`;
    }

    const msgs = [];
    if (!p.converged && p.iterations > 0) {
      msgs.push(
        `The relaxation stopped ${p.unmet.toFixed(2)} px short of the ${(+el.padding.value).toFixed(1)} px ` +
        `padding after ${p.iterations} iterations.`);
      msgs.push(p.atCap > 0
        ? `${p.atCap} state${p.atCap === 1 ? " is" : "s are"} pinned against the ` +
          `${p.maxShift.toFixed(0)} px cap on how far a state may drift from its hand-drawn slot, ` +
          `so there is nowhere left to push. Raise the state size number or lower the padding.`
        : `At this state size there may be no layout that fits. Raise the state size number or lower the padding.`);
    }
    // an uploaded map is solved expanded then fitted back, so the gap enforced
    // and the gap drawn are not the same number
    // the slots stopped working, so say so rather than leaving it to be inferred
    if (p.mode === "free" && !payload.uploaded)
      msgs.push(
        "These seat counts do not fit the hand-drawn slots, so placement fell back to " +
        "seeding each state at its own centre and letting gravity and separation find " +
        "a layout. Adjust it with Compaction.");
    if (p.expand && Math.abs(p.effectivePadding - +el.padding.value) > 0.15)
      msgs.push(
        `The ${(+el.padding.value).toFixed(1)} px padding was enforced on the spread-out layout; ` +
        `after refitting to the frame the drawn gaps are about ${p.effectivePadding.toFixed(1)} px.`);
    if (p.coarsened)
      msgs.push(
        `Disc spacing was backed off to ${p.spacing.toFixed(2)} px to stay inside the ` +
        `${(40000).toLocaleString()}-disc budget, so contacts are resolved slightly more coarsely than ` +
        `padding/2 would give.`);
    warn(msgs.join(" "));
  }

  function warn(text) {
    el.warn.hidden = !text;
    el.warn.textContent = text || "";
  }

  /* ------------------------------------------------------ seats from CSV ---- */

  function loadSeatsFile(file) {
    warn("");
    el.seatsNote.textContent = "reading " + file.name + "…";
    const reader = new FileReader();
    reader.onerror = () => { warn("Could not read that file."); el.seatsNote.textContent = SEATS_NOTE; };
    reader.onload = () => {
      let r;
      try {
        r = CartogramSolver.seatsFromTable(
          CartogramSolver.parseDelimited(reader.result), payload.states, el.matchOn.value);
      } catch (e) {
        warn("Could not read that table: " + e.message);
        el.seatsNote.textContent = SEATS_NOTE;
        return;
      }
      if (!r.matched) {
        warn(`Nothing in ${file.name} matched a region on the map. It needs a column of ` +
             `names or codes — this map uses ${payload.states.slice(0, 3).map((s) => s.st).join(", ")}` +
             `${payload.states.length > 3 ? ", …" : ""}.` +
             (r.unmatched.length ? ` The file had ${JSON.stringify(r.unmatched.slice(0, 3))}.` : ""));
        el.seatsNote.textContent = SEATS_NOTE;
        return;
      }

      // regions the file did not mention keep whatever they had, rather than
      // being silently reset to 1
      const merged = {};
      for (const s of payload.states) merged[s.st] = r.table[s.st] != null ? r.table[s.st] : (customSeats[s.st] || 1);
      el.seats.value = "custom";
      setSeats(merged);
      syncOutputs();

      const bits = [`${r.matched} of ${payload.states.length} regions set from ${file.name}`];
      if (r.header) bits.push(`using the “${r.header[r.valCol] || "?"}” column`);
      const tail = [];
      if (r.missing.length) tail.push(`${r.missing.length} not in the file kept their previous value` +
        ` (${r.missing.slice(0, 4).join(", ")}${r.missing.length > 4 ? ", …" : ""})`);
      if (r.unmatched.length) tail.push(`${r.unmatched.length} row${r.unmatched.length > 1 ? "s" : ""} ` +
        `matched no region (${r.unmatched.slice(0, 3).map((u) => `“${u}”`).join(", ")}` +
        `${r.unmatched.length > 3 ? ", …" : ""})`);
      if (r.bad) tail.push(`${r.bad} row${r.bad > 1 ? "s" : ""} had no usable number`);
      el.seatsNote.textContent = bits.join(", ") + ". " + (tail.length ? tail.join("; ") + "." : "");

      solve();
    };
    reader.readAsText(file);
  }

  /* --------------------------------------------------- custom geography ---- */

  /* The solver is loaded in the page as well as in the worker, so a file can be
   * turned into a payload here and shipped over as one `init`. */
  function useGeography(next, note) {
    payload = next;
    // An uploaded file's seat counts come from the file itself; the built-in map
    // starts from its real districts. Going through seatsFromSource("custom")
    // here would read the PREVIOUS geography's table, whose ids no longer exist.
    customSeats = {};
    for (const s of payload.states) {
      customSeats[s.st] = payload.uploaded
        ? (s.seats && s.seats.custom) || 1
        : s.districts.length;
    }
    buildSeatGrid();
    buildMatchOptions();

    // say what is loaded, however we got here -- button, dialog or drop
    if (payload.uploaded) {
      el.geoCurrent.textContent = payload.meta.title;
      el.geoCurrent.title = payload.meta.title;
      el.geoLoad.textContent = "Choose a different map file…";
      el.geoClear.hidden = false;
      el.seats.value = "custom";
      // the apportionment years describe the United States, not this file
      for (const o of el.seats.options) o.disabled = o.value !== "custom";
    } else {
      el.geoCurrent.textContent = "U.S. states";
      el.geoCurrent.title = "";
      el.geoLoad.textContent = "Choose a map file…";
      el.geoClear.hidden = true;
      for (const o of el.seats.options) o.disabled = false;
      if (el.seats.value === "custom") el.seats.value = "districts";
    }

    el.geoNote.textContent = note;
    syncOutputs();

    if (worker) worker.terminate();
    worker = null;
    startWorker();
  }

  function loadGeographyFile(file) {
    const MAX = 40 * 1024 * 1024;
    if (file.size > MAX) {
      warn(`That file is ${(file.size / 1048576).toFixed(0)} MB. The limit here is 40 MB — ` +
           `simplify it first (mapshaper's ‑simplify does this well).`);
      return;
    }
    warn("");
    el.geoNote.textContent = "reading " + file.name + "…";

    const reader = new FileReader();
    reader.onerror = () => warn("Could not read that file.");
    reader.onload = () => {
      let gj;
      try {
        gj = JSON.parse(reader.result);
      } catch (e) {
        warn("That file is not valid JSON: " + e.message);
        resetGeoNote();
        return;
      }
      let ing;
      try {
        ing = CartogramSolver.ingestGeoJSON(gj, {
          width: builtin.design.width, height: builtin.design.height,
        });
      } catch (e) {
        warn("Could not use that file: " + e.message);
        resetGeoNote();
        return;
      }

      const next = {
        meta: { title: file.name },
        design: builtin.design,
        defaults: builtin.defaults,
        totalArea: ing.totalArea,
        newEngland: [],
        palette: builtin.palette,
        states: ing.states,
        uploaded: true,
        geographyId: file.name + ":" + file.size,
      };

      const hasSeats = ing.states.some((s) => s.seats.custom > 1);
      const t = ing.topology;
      useGeography(next,
        `${ing.states.length} regions from ${file.name}. ` +
        (t
          ? `TopoJSON, decoded from ${t.objectCount > 1
              ? `the “${t.object}” layer — it has ${t.objectCount}, and this was the one with the most polygons`
              : `the “${t.object}” layer`}. `
          : "") +
        (ing.projected
          ? "Longitude/latitude detected, projected equal-area. "
          : "Coordinates used as given — assumed already projected and equal-area. ") +
        (hasSeats
          ? "Seat counts read from the file. "
          : "No seat property found, so every region starts at 1 — edit them below. ") +
        "A file has no hand-drawn slots, so regions are seeded at their own centres, " +
        "the arrangement is spread until the relaxation can separate them, and the " +
        "result is fitted back to the frame.");
    };
    reader.readAsText(file);
  }

  /* ------------------------------------------------------------- wiring ---- */

  for (const c of [el.divisor, el.padding, el.points, el.gravity, el.links])
    c.addEventListener("input", () => schedule(220));
  for (const c of [el.seats, el.cells, el.seed]) c.addEventListener("change", () => schedule(0));
  el.placement.addEventListener("change", () => { syncOutputs(); if (el.placement.value !== "soft") solve(); else markStale(true); });
  for (const c of [el.tweaks, el.groupNE, el.colour]) c.addEventListener("change", () => schedule(0));
  el.ghost.addEventListener("change", () => schedule(0));

  el.reroll.addEventListener("click", () => {
    el.seed.value = Math.floor(Math.random() * 1e8);
    schedule(0);
  });

  // switching TO custom carries over whatever was showing, so the grid starts
  // from something recognisable rather than all ones
  let lastSource = "districts";
  el.seats.addEventListener("change", () => {
    if (el.seats.value === "custom") setSeats(seatsFromSource(lastSource));
    else lastSource = el.seats.value;
  });

  el.seatCopy.addEventListener("click", () => {
    setSeats(seatsFromSource(payload.uploaded ? "custom" : lastSource));
    schedule(0);
  });
  const setAll = (n) => {
    const t = {};
    for (const s of payload.states) t[s.st] = n;
    setSeats(t);
    schedule(0);
  };
  el.seatOne.addEventListener("click", () => setAll(1));
  el.seatTwo.addEventListener("click", () => setAll(2));

  /* Drop a file anywhere on the map. Which kind it is comes from the content,
   * not the extension: a .json holding a table and a .txt holding GeoJSON are
   * both things people actually have. */
  const drop = document.querySelector(".cs-mapwrap");
  if (drop) {
    let depth = 0;
    const over = (on) => drop.classList.toggle("cs-dropping", on);
    drop.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; over(true); });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    drop.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; over(false); } });
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0; over(false);
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const head = new FileReader();
      head.onload = () => {
        const t = String(head.result).replace(/^﻿/, "").trimStart();
        if (t.startsWith("{") || t.startsWith("[")) loadGeographyFile(f);
        else loadSeatsFile(f);
      };
      head.readAsText(f.slice(0, 512));
    });
  }

  el.geoLoad.addEventListener("click", () => el.geoFile.click());
  el.geoClear.addEventListener("click", () => builtin && useGeography(builtin, GEO_NOTE));
  el.geoFile.addEventListener("change", () => {
    const f = el.geoFile.files && el.geoFile.files[0];
    // clear it, or re-picking the same file fires no change event
    el.geoFile.value = "";
    if (f) loadGeographyFile(f);
  });

  el.seatsLoad.addEventListener("click", () => el.seatsFile.click());
  el.seatsFile.addEventListener("change", () => {
    const f = el.seatsFile.files && el.seatsFile.files[0];
    el.seatsFile.value = "";
    if (f) loadSeatsFile(f);
  });
  el.solve.addEventListener("click", solve);
  el.reset.addEventListener("click", () => {
    // reset means the build's settings, which includes the built-in geography
    if (payload && payload.uploaded && builtin) useGeography(builtin, GEO_NOTE);
    el.seatsNote.textContent = SEATS_NOTE;
    lastSource = DEFAULTS.seats;
    el.seats.value = DEFAULTS.seats;
    el.divisor.value = DEFAULTS.divisor;
    el.padding.value = DEFAULTS.padding;
    el.tweaks.checked = DEFAULTS.tweaks;
    el.groupNE.checked = DEFAULTS.groupNE;
    el.cells.value = DEFAULTS.cells;
    el.colour.checked = DEFAULTS.colour;
    el.points.value = DEFAULTS.points;
    el.seed.value = DEFAULTS.seed;
    el.ghost.checked = DEFAULTS.ghost;
    el.gravity.value = DEFAULTS.gravity;
    el.links.value = DEFAULTS.links;
    el.matchOn.value = "auto";
    el.placement.value = "auto";
    syncOutputs();
    solve();
  });

  syncOutputs();

  /* --------------------------------------------------------------- boot ---- */

  if (window.STUDIO_DATA) {
    start(window.STUDIO_DATA);
  } else {
    fetch(root.dataset.src)
      .then((r) => {
        if (!r.ok) throw new Error(r.status + " " + r.statusText);
        return r.json();
      })
      .then(start)
      .catch((e) => warn("Could not load the geometry: " + e.message));
  }
})();
