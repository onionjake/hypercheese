#!/usr/bin/env node
'use strict';
// Backup-tab grid render benchmark. See bench/grid/RESULTS.md for the method.
//
//   node bench/grid/run.js                    # current working tree
//   node bench/grid/run.js --rev HEAD         # library.tsx as of a git revision
//   node bench/grid/run.js --reps 25 --out bench/grid/results/after.json
//
// Mounts src/app/(tabs)/library.tsx with react-dom (production *profiling*
// build) over a tiny DOM shim, React Native's real FlatList/VirtualizedList,
// and in-memory fakes for the catalog DB and upload queue. Layout is
// simulated for a 412x650dp list viewport (a typical Android phone), so the
// VirtualizedList windows exactly as it would on device.

process.env.NODE_ENV = 'production';
globalThis.__DEV__ = false;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');

// ---- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const REPS = Number(arg('reps', 15));
const WARMUP = Number(arg('warmup', 3));
const TOTAL_ASSETS = Number(arg('catalog', 2000));
const TARGET_LOADED = Number(arg('loaded', 1000));
const OUT = arg('out', null);
const REV = arg('rev', null);
const LABEL = arg('label', REV ? `rev ${REV}` : 'working tree');

// ---- timers: track pending app timers so "settled" means really idle --------
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const pendingTimers = new Set();
globalThis.setTimeout = function (fn, ms, ...rest) {
  const handle = realSetTimeout(() => {
    pendingTimers.delete(handle);
    fn(...rest);
  }, ms);
  pendingTimers.add(handle);
  return handle;
};
globalThis.clearTimeout = function (handle) {
  pendingTimers.delete(handle);
  realClearTimeout(handle);
};
// One vsync = 16ms; the app may coalesce work into frames.
globalThis.requestAnimationFrame = (cb) => globalThis.setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame = (h) => globalThis.clearTimeout(h);

// VirtualizedList's "large list slow to update" hint fires during setup
// only because the synthetic scroll events are spaced 1s apart; drop it.
const realLog = console.log;
console.log = (...a) => {
  if (typeof a[0] === 'string' && a[0].startsWith('VirtualizedList: You have a large list')) return;
  realLog(...a);
};

// ---- DOM + loader -------------------------------------------------------------
const { install, walk, hostStats } = require('./dom-shim');
const { container } = install();
const { ROOT, compilerEvents } = require('./loader');
const { counters, reset: resetCounters, snapshot: snapCounters } = require('./counters');
const { io, hop } = require('./mocks/app/io');
const libraryDb = require('./mocks/app/library-db');
const queue = require('./mocks/app/upload-queue');
const RN = require('./mocks/react-native');

const React = require('react');
const ReactDOM = require('react-dom/profiling');

// ---- the screen under test ---------------------------------------------------
const SCREEN_REL = 'src/app/(tabs)/library.tsx';
let screenPath = path.join(ROOT, SCREEN_REL);
if (REV) {
  const code = execFileSync('git', ['show', `${REV}:instacheese/${SCREEN_REL}`], { cwd: ROOT, encoding: 'utf8' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-bench-'));
  screenPath = path.join(dir, 'library.tsx');
  fs.writeFileSync(screenPath, code);
}
libraryDb.__seed(TOTAL_ASSETS);
const LibraryScreen = require(screenPath).default;

// ---- geometry ------------------------------------------------------------------
const WIDTH = RN.WINDOW.width; // 412dp
const VIEWPORT = 650; // list height between chips and the button bar
const ROW = WIDTH / 3; // 3 square cells (margin 1) per row

// ---- profiler --------------------------------------------------------------------
const prof = { commits: 0, renderMs: 0, maxCommitMs: 0, sinceCheck: 0 };
function onRender(id, phase, actualDuration) {
  prof.commits++;
  prof.sinceCheck++;
  prof.renderMs += actualDuration;
  if (actualDuration > prof.maxCommitMs) prof.maxCommitMs = actualDuration;
}

// ---- simulated native layout -------------------------------------------------------
let scrollEl = null;
const sent = { viewport: false, content: -1 };
const lastLayout = new WeakMap();

function findScroll() {
  if (scrollEl && scrollEl.getRootNode() === container.getRootNode()) return scrollEl;
  scrollEl = null;
  for (const el of walk(container)) {
    if (el.localName === 'rn-scroll' && el._p && el._p.onContentSizeChange && !el._p.horizontal) {
      scrollEl = el;
      break;
    }
  }
  return scrollEl;
}

function flatStyle(style) {
  return RN.StyleSheet.flatten(style) || {};
}

// Like Fabric after a commit: fire onLayout for views whose frame changed and
// onContentSizeChange if the content height changed. Returns events fired.
function layoutPass() {
  const scroll = findScroll();
  if (!scroll) return 0;
  let events = 0;
  const p = scroll._p;
  if (!sent.viewport) {
    sent.viewport = true;
    p.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: WIDTH, height: VIEWPORT } } });
    events++;
  }
  const content = scroll.childNodes[0];
  let y = 0;
  for (const child of content.childNodes) {
    if (child.nodeType !== 1) continue;
    const cp = child._p || {};
    const st = flatStyle(cp.style);
    let h;
    if (!cp.onLayout && typeof st.height === 'number') h = st.height; // spacer
    else h = ROW; // a grid row (CellRenderer view)
    if (cp.onLayout) {
      const prev = lastLayout.get(child);
      if (!prev || prev.y !== y || prev.height !== h) {
        const layout = { x: 0, y, width: WIDTH, height: h };
        lastLayout.set(child, layout);
        cp.onLayout({ nativeEvent: { layout } });
        events++;
      }
    }
    y += h;
  }
  if (y !== sent.content) {
    sent.content = y;
    p.onContentSizeChange?.(WIDTH, y);
    events++;
  }
  return events;
}

let scrollTs = 0;
function scrollTo(offset) {
  const scroll = findScroll();
  scrollTs += 1000;
  scroll._p.onScroll({
    timeStamp: scrollTs,
    nativeEvent: {
      contentOffset: { x: 0, y: offset },
      contentSize: { width: WIDTH, height: sent.content },
      layoutMeasurement: { width: WIDTH, height: VIEWPORT },
      zoomScale: 1,
    },
  });
}

const idle = (ms) => new Promise((r) => realSetTimeout(r, ms));
const turn = () => new Promise((r) => setImmediate(r));

// Wait until the app is idle: no React commits, no layout events, no fake
// native calls in flight and no pending app timers, for 3 consecutive turns.
// Waiting on timers is done with an idle sleep so it isn't counted as busy.
async function settle() {
  let quiet = 0;
  while (quiet < 3) {
    await turn();
    const events = layoutPass();
    if (prof.sinceCheck > 0 || events > 0 || io.pending > 0) {
      prof.sinceCheck = 0;
      quiet = 0;
    } else if (pendingTimers.size > 0) {
      await idle(4);
      quiet = 0;
    } else {
      quiet++;
    }
  }
}

function loadedAssets() {
  return findScroll()?._p.data ?? [];
}

function mountedCells() {
  const out = [];
  const scroll = findScroll();
  if (!scroll) return out;
  for (const el of walk(scroll)) {
    if (el._p && el._p.accessibilityRole === 'checkbox') out.push(el);
  }
  return out;
}

function cellFor(filename) {
  return mountedCells().find((el) => el._p.accessibilityLabel === filename);
}

// ---- measurement -------------------------------------------------------------------
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function measureOnce(fn) {
  await settle();
  resetCounters();
  const host0 = { ...hostStats };
  prof.commits = 0;
  prof.renderMs = 0;
  prof.maxCommitMs = 0;
  prof.sinceCheck = 0;
  const elu0 = performance.eventLoopUtilization();
  await fn();
  await settle();
  const elu = performance.eventLoopUtilization(elu0);
  return {
    busyMs: elu.active,
    renderMs: prof.renderMs,
    maxCommitMs: prof.maxCommitMs,
    commits: prof.commits,
    ...snapCounters(),
    hostUpdates: hostStats.propUpdates - host0.propUpdates,
    hostCreated: hostStats.created - host0.created,
  };
}

async function scenario(name, describe, makeRep, reps = REPS, warmup = WARMUP) {
  const runs = [];
  for (let i = 0; i < warmup + reps; i++) {
    const r = await measureOnce(() => makeRep(i));
    if (i >= warmup) runs.push(r);
  }
  const keys = Object.keys(runs[0]);
  const med = {};
  for (const k of keys) med[k] = median(runs.map((r) => r[k]));
  const p90 = (k) => {
    const s = runs.map((r) => r[k]).sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
  };
  med.busyMsP90 = p90('busyMs');
  med.renderMsP90 = p90('renderMs');
  results.scenarios[name] = { describe, reps: runs.length, median: med };
  const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(2));
  console.log(
    `${name.padEnd(28)} busy ${fmt(med.busyMs).padStart(8)}ms  render ${fmt(med.renderMs).padStart(8)}ms  ` +
      `commits ${fmt(med.commits).padStart(3)}  screen ${fmt(med.screen).padStart(3)}  rows ${fmt(med.cellRenderer).padStart(4)}  ` +
      `cells ${fmt(med.cell).padStart(4)}  images ${fmt(med.image).padStart(4)}  icons ${fmt(med.icon).padStart(4)}  host ${fmt(med.hostUpdates).padStart(5)}`
  );
}

const results = { label: LABEL, node: process.version, reps: REPS, warmup: WARMUP, env: {}, scenarios: {} };

// ---- main ------------------------------------------------------------------------------
async function main() {
  const root = ReactDOM.createRoot(container);
  root.render(React.createElement(React.Profiler, { id: 'screen', onRender }, React.createElement(LibraryScreen)));
  await settle();

  // Scroll down like a user paging through the camera roll until ~1,000
  // assets are loaded (onEndReached pages in 120 at a time).
  let guard = 0;
  while (loadedAssets().length < TARGET_LOADED && guard++ < 200) {
    scrollTo(Math.max(0, sent.content - VIEWPORT));
    await settle();
  }
  const loaded = loadedAssets();
  // Then park in the middle of what's loaded, the way the reported session
  // would be: deep in the grid, with a full window mounted above and below.
  const midRow = Math.floor(loaded.length / 3 / 2);
  for (let step = 0; step < 3; step++) {
    scrollTo(midRow * ROW);
    await settle();
  }
  const cells = mountedCells();
  const visibleTop = midRow * 3;
  const visible = loaded.slice(visibleTop, visibleTop + Math.floor(VIEWPORT / ROW) * 3);
  results.env = {
    catalog: TOTAL_ASSETS,
    loadedAssets: loaded.length,
    scrollRow: midRow,
    viewport: `${WIDTH}x${VIEWPORT}dp`,
    mountedCells: cells.length,
    mountedRows: Math.ceil(cells.length / 3),
  };
  console.log(`\n${LABEL}: ${loaded.length} assets loaded, ${cells.length} cells mounted (${Math.ceil(cells.length / 3)} rows), scrolled to row ${midRow}\n`);

  const asItem = (a, status, extra = {}) => ({
    key: `asset:${a.id}`,
    source: 'backup',
    assetId: a.id,
    localUri: null,
    thumbUri: null,
    filename: a.filename,
    path: a.filename,
    mtime: a.mtime,
    size: null,
    status,
    error: null,
    ...extra,
  });
  const supportedVisible = visible.filter((a) => a.supported);

  await scenario('noop (harness floor)', 'settle() with nothing to do', async () => {});

  await scenario(
    'item event, visible asset',
    "one emitItem (hashing/uploading) for an asset on screen",
    async (i) => {
      queue.emitItem(asItem(supportedVisible[0], i % 2 ? 'hashing' : 'uploading'));
    }
  );

  await scenario(
    'item event, asset not loaded',
    'one emitItem for an asset that is not in the loaded list (typical after Back up reloads Unmarked)',
    async (i) => {
      queue.emitItem({ ...asItem({ id: 'not-loaded-x', filename: 'x.jpg', mtime: 1 }, i % 2 ? 'hashing' : 'uploading') });
    }
  );

  await scenario(
    "'checking' burst x200",
    "drain marks a batch of 200 'checking': 200 emitItem calls in one synchronous loop",
    async () => {
      const start = Math.max(0, visibleTop - 60);
      const batch = loaded.slice(start, start + 200);
      batch.forEach((a) => queue.emitItem(asItem(a, 'checking')));
    }
  );

  await scenario(
    'summary change only',
    'queue summary broadcast with a new current phase (no item change)',
    async (i) => {
      const s = queue.getSummary();
      queue.broadcastSummary({
        ...s,
        current: { key: `k${i}`, filename: `f${i}.jpg`, phase: i % 2 ? 'hashing' : 'uploading', bytesSent: 0, bytesTotal: 1 },
      });
    }
  );

  let fileIdx = 0;
  await scenario(
    'one file upload cycle',
    'setCurrent+setItemStatus for hashing and uploading, 2 progress ticks, settle(done) + summary, then the 500ms counts debounce',
    async () => {
      const a = supportedVisible[(fileIdx++ % (supportedVisible.length - 2)) + 1];
      const base = queue.getSummary();
      const cur = (phase) => ({ key: `asset:${a.id}`, filename: a.filename, phase, bytesSent: 0, bytesTotal: 1000 });
      for (const phase of ['hashing', 'uploading']) {
        queue.broadcastSummary({ ...base, current: cur(phase) });
        await turn();
        queue.emitItem(asItem(a, phase));
        await turn();
      }
      for (let t = 0; t < 2; t++) {
        queue.broadcastSummary({ ...queue.getSummary(), current: { ...cur('uploading'), bytesSent: 300 * (t + 1) } });
        await turn();
      }
      queue.emitItem(asItem(a, 'done'));
      queue.broadcastSummary({
        ...base,
        current: null,
        remaining: Math.max(0, base.remaining - 1),
        finished: base.finished + 1,
      });
    }
  );

  await scenario('tap (select toggle)', 'onPress on a visible cell: setSelected → setAssets → libraryCounts → setCounts', async () => {
    const el = cellFor(supportedVisible[0].filename);
    el._p.onPress();
  });

  let wontIdx = 0;
  await scenario(
    "won't upload (long-press)",
    "onLongPress → Alert → \"Won't upload\": setExcluded, removeQueued, setAssets, counts",
    async () => {
      const mounted = new Set(mountedCells().map((el) => el._p.accessibilityLabel));
      const candidates = loadedAssets().filter(
        (a) => a.supported && !a.excluded && a.status !== 'synced' && mounted.has(a.filename)
      );
      const a = candidates[wontIdx++ % candidates.length];
      cellFor(a.filename)._p.onLongPress();
      const btn = RN.__state.lastAlert.buttons.find((b) => b.text === "Won't upload");
      btn.onPress();
    }
  );

  await scenario(
    'drain batch of 200 (all exist)',
    "a whole drain batch whose files the server already has: 'checking' burst, per-item size resolve " +
      '(setCurrent + 3 native calls), manifest, then per-item settle(exists) (3 native calls + emitItem + summary)',
    async () => {
      const start = Math.max(0, visibleTop - 60);
      const batch = loaded.slice(start, start + 200);
      const base = queue.getSummary();
      batch.forEach((a) => queue.emitItem(asItem(a, 'checking')));
      for (const a of batch) {
        queue.broadcastSummary({
          ...base,
          current: { key: `asset:${a.id}`, filename: a.filename, phase: 'checking', bytesSent: 0, bytesTotal: 0 },
        });
        await hop(); // uploadAllowedRecently / resolveLocalUri
        await hop(); // getInfoAsync
        await hop(); // UPDATE uploads SET size
      }
      queue.broadcastSummary({ ...base, current: null });
      await hop(); // manifest request
      let done = 0;
      for (const a of batch) {
        await hop(); // stillWanted
        await hop(); // UPDATE uploads
        await hop(); // markStatus
        done++;
        queue.emitItem(asItem(a, 'exists'));
        queue.broadcastSummary({ ...base, current: null, remaining: base.remaining - done, finished: base.finished + done });
      }
      queue.broadcastSummary(base);
    },
    Number(arg('batch-reps', 5)),
    1
  );

  results.compiler = compilerEvents
    .filter((e) => e.file.startsWith('src/') || e.file.includes('grid-bench-'))
    .map((e) => ({ ...e, file: e.file.includes('grid-bench-') ? `${SCREEN_REL} @ ${REV}` : e.file }));
  console.log('\nReact Compiler on app code:');
  for (const e of results.compiler)
    console.log(`  ${e.kind.padEnd(13)} ${e.file}:${e.line ?? '?'} ${e.fn ?? ''} ${e.reason ? `— ${e.reason}` : ''}`);

  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(OUT), JSON.stringify(results, null, 2) + '\n');
    console.log(`\nwrote ${OUT}`);
  }
  root.unmount();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
