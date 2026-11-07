#!/usr/bin/env node
'use strict';
// Prints a Markdown before/after table from two run.js --out files.
//   node bench/grid/compare.js bench/grid/results/before.json bench/grid/results/after.json
const fs = require('fs');

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: compare.js before.json after.json');
  process.exit(1);
}
const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));

const ms = (x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
const n = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const pair = (b, a, f) => `${f(b)} → ${f(a)}`;

console.log(`Mounted window: ${before.env.mountedCells} → ${after.env.mountedCells} cells ` +
  `(${before.env.mountedRows} → ${after.env.mountedRows} rows), ${before.env.loadedAssets} assets loaded, ` +
  `viewport ${before.env.viewport}, scrolled to row ${before.env.scrollRow}.\n`);
console.log(
  '| Scenario | JS busy ms (median) | React render ms (median) | Commits | Screen renders | Row renders | Cell renders | Host prop updates | Image mounts / unmounts |'
);
console.log('|---|---|---|---|---|---|---|---|---|');
for (const [name, { median: b }] of Object.entries(before.scenarios)) {
  const s = after.scenarios[name];
  if (!s) continue;
  const a = s.median;
  console.log(
    `| ${name} | ${pair(b.busyMs, a.busyMs, ms)} | ${pair(b.renderMs, a.renderMs, ms)} | ${pair(b.commits, a.commits, n)} | ` +
      `${pair(b.screen, a.screen, n)} | ${pair(b.cellRenderer, a.cellRenderer, n)} | ${pair(b.cell, a.cell, n)} | ` +
      `${pair(b.hostUpdates, a.hostUpdates, n)} | ${n(b.imageMount)}/${n(b.imageUnmount)} → ${n(a.imageMount)}/${n(a.imageUnmount)} |`
  );
}
