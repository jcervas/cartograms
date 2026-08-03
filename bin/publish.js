#!/usr/bin/env node
/* Publish the studio and the placement walkthrough into jcervas.github.io.
 *
 *   node bin/publish.js ../jcervas.github.io
 *
 * This step had been lost. The repository was reset to an empty commit and the
 * original tooling went with it, so what follows was recovered by reading the
 * published output: the filenames carry a content hash, and that hash is the
 * first eight hex characters of the file's SHA-256. Verified against six assets
 * still live at the time of writing -- solver.8ed51b2d.js, studio.css
 * (e71a68a4), placement.css, doc.css, placement.json and placement.js all match
 * exactly.
 *
 * The one thing that could NOT be reproduced is the old worker filename. Its
 * hash is not the SHA-256 of any form of the worker that survives, so whatever
 * bytes it was taken over are gone. Nothing depends on matching it: the hash
 * exists only to stop a browser serving a stale solver, so any rule works as
 * long as the name changes when the contents do. This script therefore uses one
 * consistent rule for everything -- hash the file exactly as published.
 *
 * That ordering matters for the worker, whose published contents name the
 * solver. Hash the solver first, substitute it in, and only then hash the
 * worker, or the name will not describe the file it is attached to.
 */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const site = process.argv[2];
if (!site) {
  console.error('usage: node bin/publish.js <path to jcervas.github.io>');
  process.exit(1);
}
const repo = path.resolve(__dirname, '..');
const studioOut = path.join(site, 'maps', 'cartogram-studio');
const placeOut = path.join(site, 'maps', 'cartogram-placement');
for (const d of [studioOut, placeOut]) {
  if (!fs.existsSync(d)) { console.error('no such directory: ' + d); process.exit(1); }
}

const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
const read = (...p) => fs.readFileSync(path.join(repo, ...p));
const written = [];
const write = (dir, name, buf) => {
  fs.writeFileSync(path.join(dir, name), buf);
  written.push(name);
  return name;
};

/* An ISO stamp with the local offset, matching what the pages already carry. */
function stamp(d) {
  const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
    (off < 0 ? '-' : '+') + p(off / 60) + ':' + p(off % 60);
}
const now = new Date();
const human = now.toLocaleDateString('en-GB',
  { day: 'numeric', month: 'long', year: 'numeric' });

/* ------------------------------------------------------------- the studio -- */

const solver = read('web', 'solver.js');
const solverName = 'solver.' + hash(solver) + '.js';

/* The worker names the solver, so it has to be substituted before it is hashed. */
const worker = Buffer.from(read('web', 'studio.worker.js').toString()
  .replace('importScripts("solver.js")', 'importScripts("' + solverName + '")'));
const workerName = 'studio.worker.' + hash(worker) + '.js';

write(studioOut, solverName, solver);
write(studioOut, workerName, worker);

const plain = {};
for (const f of ['studio.js', 'studio.css', 'studio.json']) {
  const buf = read('web', f);
  plain[f] = hash(buf);
  write(studioOut, f, buf);
}

let html = read('web', 'index.html').toString();
/* Substitute only inside the Liquid asset paths. A blanket replace also hits
 * the prose -- the page credits "web/solver.js" in its footer and names
 * "sh/12_test_solver.js" in the text, and both came out carrying a content
 * hash, which is wrong and faintly absurd. */
const assetRef = (file, name) => new RegExp(
  "('/maps/cartogram-studio/)" + file.replace(/\./g, '\\.') + "(')", 'g');
html = html.replace(assetRef('solver.js'), "$1" + solverName + "$2")
           .replace(assetRef('studio.worker.js'), "$1" + workerName + "$2");
for (const [f, h] of Object.entries(plain)) {
  html = html.replace(
    new RegExp("('/maps/cartogram-studio/" + f.replace('.', '\\.') + "' \\| relative_url \\}\\})(\\?v=[0-9a-f]+)?", 'g'),
    "$1?v=" + h);
}
html = html.replace(/<time datetime="[^"]*">[^<]*<\/time>/,
  '<time datetime="' + stamp(now) + '">' + human + '</time>');
write(studioOut, 'index.html', Buffer.from(html));

/* Sweep away hashed files this run did not write, or the directory silently
 * accumulates every solver ever published. */
for (const f of fs.readdirSync(studioOut)) {
  if (/^(solver|studio\.worker)\.[0-9a-f]{8}\.js$/.test(f) && !written.includes(f)) {
    fs.unlinkSync(path.join(studioOut, f));
    console.log('  removed stale ' + f);
  }
}

/* -------------------------------------------------------- the walkthrough -- */

const placeAssets = {};
for (const f of ['placement.js', 'placement.css', 'placement.json', 'doc.css']) {
  const buf = read('placement', f);
  placeAssets[f] = hash(buf);
  fs.writeFileSync(path.join(placeOut, f), buf);
}
let md = read('placement', 'index.md').toString();
for (const [f, h] of Object.entries(placeAssets)) {
  md = md.replace(
    new RegExp("('/maps/cartogram-placement/" + f.replace('.', '\\.') + "' \\| relative_url \\}\\})(\\?v=[0-9a-f]+)?", 'g'),
    "$1?v=" + h);
}
md = md.replace(/\*Updated [^*]*\.\*/, '*Updated ' + human + '.*');
fs.writeFileSync(path.join(placeOut, 'index.md'), md);

console.log('studio     -> ' + solverName + ', ' + workerName);
for (const [f, h] of Object.entries(plain)) console.log('              ' + f + '?v=' + h);
console.log('placement  -> index.md + 4 assets');
console.log('stamped    ' + human);
