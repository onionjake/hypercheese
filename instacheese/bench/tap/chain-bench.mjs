// Native-call side of a Backup-tab tap: loads the REAL mark-reminder.ts and
// settings.ts (working tree or baseline commit) with expo-notifications,
// expo-secure-store (via ./auth), expo-file-system and the catalog mocked by
// counters, then replays library.tsx's call pattern on a virtual clock:
//
//   toggle          -> setSelected; refreshCounts()  (count unchanged)
//   won't upload    -> setExcluded; removeQueued; refreshCounts()  (count - 1)
//   queue settle    -> refreshCountsSoon() (500 ms debounce, as library.tsx)
//   refreshCounts() =  await libraryCounts(); refreshMarkReminder(n)  (not awaited)
//
// Every native call goes through ONE serial queue, modelling expo-modules'
// single "expo.modules.AsyncFunctionQueue" HandlerThread on Android (see
// RESULTS.md); SQL goes through a second queue (the shared connection).
// Latencies are ASSUMPTIONS (profiles below), jittered +-30% per call with a
// seeded RNG; each scenario is run with several seeds and medians reported.
// Call COUNTS do not depend on the latency assumptions except via coalescing.
//
//   node bench/tap/chain-bench.mjs --impl=baseline|current [--runs=7]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { rng } from './lib/catalog.mjs';
import { APP_DIR, loadTs, median, parseArgs } from './lib/load-ts.mjs';

const args = parseArgs(process.argv.slice(2));
const impl = args.impl ?? 'current';
const RUNS = Number(args.runs ?? 7);

// ---- latency profiles (ms) — ASSUMPTIONS, not device measurements ---------
const PROFILES = {
  // Plausible mid-range Android, app otherwise idle.
  nominal: {
    'SecureStore.getValueWithKeyAsync': 15, // Keystore AES-GCM decrypt
    'Notifications.getPermissionsAsync': 3,
    'Notifications.cancelScheduledNotificationAsync': 25, // broadcast round trip + AlarmManager + prefs
    'Notifications.setNotificationChannelAsync': 5,
    'Notifications.scheduleNotificationAsync': 30, // broadcast round trip + AlarmManager + prefs
    'FileSystem.readAsStringAsync': 3,
    'FileSystem.writeAsStringAsync': 5,
    'SecureStore.deleteValueWithKeyAsync': 15,
    'Notifications.requestPermissionsAsync': 3,
    // One library scan page read (getAssetsAsync, 500 assets) holding the
    // shared native queue — only used by the scan scenario.
    'MediaLibrary.getAssetsAsync': 250,
    'sql.write': 1, // setSelected / setExcluded (bench: ~0.3 ms desktop)
    'queue.removeQueued': 2,
  },
  // Same calls while uploads keep the shared native queue and main thread
  // busy (hashing, file reads, progress events): everything 4x slower.
  congested: null,
};
PROFILES.congested = Object.fromEntries(Object.entries(PROFILES.nominal).map(([k, v]) => [k, v * 4]));

// libraryCounts at 60k rows: measured desktop medians from sql-bench (see
// RESULTS.md), x3 as an ASSUMED phone factor.
const LIBRARY_COUNTS_MS = { baseline: 24.3 * 3, current: 4.0 * 3 };

// ---- virtual clock --------------------------------------------------------
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = [];
  const clock = {
    get now() {
      return now;
    },
    sleep(ms) {
      return new Promise((resolve) => clock.at(now + Math.max(0, ms), resolve));
    },
    at(t, fn) {
      const timer = { t, seq: seq++, fn, cancelled: false };
      timers.push(timer);
      return timer;
    },
    async run() {
      for (;;) {
        await new Promise((r) => setImmediate(r)); // drain microtasks
        timers.sort((a, b) => a.t - b.t || a.seq - b.seq);
        const next = timers.shift();
        if (!next) return;
        if (next.cancelled) continue;
        now = Math.max(now, next.t);
        next.fn();
      }
    },
  };
  return clock;
}

// ---- one simulated app process -------------------------------------------
function makeWorld(seed, profileName) {
  const profile = PROFILES[profileName];
  const clock = makeClock();
  const rand = rng(seed);
  const calls = {};
  const os = { scheduled: new Map(), channel: false, violations: [] };
  const state = { session: { baseUrl: 'https://cheese', mode: 'token', token: 't' }, unmarked: 17838 };
  const jitter = (ms) => ms * (0.7 + 0.6 * rand());

  let nativeTail = Promise.resolve();
  let nativeBusy = 0;
  function native(name, effect) {
    calls[name] = (calls[name] ?? 0) + 1;
    const run = nativeTail.then(async () => {
      const t0 = clock.now;
      await clock.sleep(jitter(profile[name]));
      nativeBusy += clock.now - t0;
      return effect?.();
    });
    nativeTail = run.catch(() => {});
    return run;
  }
  let sqlTail = Promise.resolve();
  function sql(name, ms, effect) {
    calls[name] = (calls[name] ?? 0) + 1;
    const run = sqlTail.then(async () => {
      await clock.sleep(jitter(ms));
      return effect?.();
    });
    sqlTail = run.catch(() => {});
    return run;
  }

  const Notifications = {
    AndroidImportance: { DEFAULT: 3 },
    SchedulableTriggerInputTypes: { DAILY: 'daily' },
    setNotificationHandler() {},
    getPermissionsAsync: () => native('Notifications.getPermissionsAsync', () => ({ granted: true, canAskAgain: true })),
    requestPermissionsAsync: () => native('Notifications.requestPermissionsAsync', () => ({ granted: true })),
    cancelScheduledNotificationAsync: (id) =>
      native('Notifications.cancelScheduledNotificationAsync', () => os.scheduled.delete(id)),
    setNotificationChannelAsync: () => native('Notifications.setNotificationChannelAsync', () => (os.channel = true)),
    scheduleNotificationAsync: (req) =>
      native('Notifications.scheduleNotificationAsync', () => {
        // (A schedule landing after sign-out's session delete but before its
        // cancel is allowed: the cancel is serialized after it and wins. The
        // final state is what's checked.)
        if (!os.channel) os.violations.push('scheduled before the Android channel existed');
        os.scheduled.set(req.identifier, req.content.body);
      }),
  };
  const settingsFile = { contents: JSON.stringify({ nightlyMarkReminder: true }) };
  const settings = loadTs('src/lib/settings.ts', impl, {
    'expo-file-system/legacy': {
      documentDirectory: 'file:///data/',
      readAsStringAsync: () => native('FileSystem.readAsStringAsync', () => settingsFile.contents),
      writeAsStringAsync: (_u, c) => native('FileSystem.writeAsStringAsync', () => (settingsFile.contents = c)),
    },
  });
  const reminder = loadTs('src/lib/mark-reminder.ts', impl, {
    'expo-media-library/legacy': { getPermissionsAsync: async () => ({ granted: false }) },
    'expo-notifications': Notifications,
    'react-native': { Platform: { OS: 'android' } },
    './auth': {
      loadStoredSession: () => native('SecureStore.getValueWithKeyAsync', () => state.session),
    },
    './library-db': {
      libraryCounts: () => sql('sql.libraryCounts', LIBRARY_COUNTS_MS[impl], () => ({ unmarked: state.unmarked })),
      refreshFromLibrary: async () => {},
    },
    './log': { log() {}, logError() {} },
    './settings': settings,
    './upload-protocol': { MEDIA_PERMISSIONS: ['photo', 'video'] },
  });

  // library.tsx, as it stands.
  let countsTimer = null;
  const tapLatency = [];
  const lib = {
    refreshCounts: async () => {
      const next = await sql('sql.libraryCounts', LIBRARY_COUNTS_MS[impl], () => ({ unmarked: state.unmarked }));
      reminder.refreshMarkReminder(next.unmarked);
    },
    refreshCountsSoon() {
      if (countsTimer) countsTimer.cancelled = true;
      countsTimer = clock.at(clock.now + 500, () => {
        countsTimer = null;
        lib.refreshCounts();
      });
    },
    lastTap: 0,
    async toggle() {
      lib.lastTap = clock.now;
      const t0 = clock.now;
      await sql('sql.write', profile['sql.write']);
      await lib.refreshCounts();
      tapLatency.push(clock.now - t0);
    },
    async wontUpload() {
      lib.lastTap = clock.now;
      const t0 = clock.now;
      await sql('sql.write', profile['sql.write'], () => state.unmarked--);
      await clock.sleep(jitter(profile['queue.removeQueued']));
      await lib.refreshCounts();
      tapLatency.push(clock.now - t0);
    },
    // Sign-out: session deleted first, then (from _layout) the cancel.
    async signOut() {
      await native('SecureStore.deleteValueWithKeyAsync', () => (state.session = null));
      const t0 = clock.now;
      await reminder.cancelMarkReminder();
      return clock.now - t0;
    },
  };
  return { clock, calls, os, state, reminder, lib, native, sql, nativeBusy: () => nativeBusy };
}

// ---- scenarios ----------------------------------------------------------
// Each returns metrics after letting everything settle.
const SCENARIOS = {
  '1 toggle (cold: first refresh since app start)': async (w) => {
    w.clock.at(0, () => w.lib.toggle());
  },
  '1 toggle (warm: reminder already scheduled)': async (w) => {
    await w.reminder.refreshMarkReminder(w.state.unmarked);
    w.mark();
    w.clock.at(w.clock.now, () => w.lib.toggle());
  },
  '20 toggles in 5 s + uploads settling every 1.5 s': async (w) => {
    await w.reminder.refreshMarkReminder(w.state.unmarked);
    w.mark();
    const t = w.clock.now;
    for (let i = 0; i < 20; i++) w.clock.at(t + i * 250, () => w.lib.toggle());
    for (let s = 0; s < 4; s++) w.clock.at(t + 700 + s * 1500, () => w.lib.refreshCountsSoon());
  },
  "20 won't-upload in 5 s + uploads settling every 1.5 s": async (w) => {
    await w.reminder.refreshMarkReminder(w.state.unmarked);
    w.mark();
    const t = w.clock.now;
    for (let i = 0; i < 20; i++) w.clock.at(t + i * 250, () => w.lib.wontUpload());
    for (let s = 0; s < 4; s++) w.clock.at(t + 700 + s * 1500, () => w.lib.refreshCountsSoon());
  },
  "20 won't-upload in 5 s during a library scan": async (w) => {
    await w.reminder.refreshMarkReminder(w.state.unmarked);
    w.mark();
    const t = w.clock.now;
    // runScan: page read on the native queue, then ~40 ms of SQL upserts, for 6 s.
    w.clock.at(t, async () => {
      while (w.clock.now < t + 6000) {
        await w.native('MediaLibrary.getAssetsAsync');
        await w.sql('sql.scanPage', 40);
      }
    });
    for (let i = 0; i < 20; i++) w.clock.at(t + i * 250, () => w.lib.wontUpload());
  },
  "20 taps in 1 s (alternating toggle / won't upload), then sign-out": async (w) => {
    await w.reminder.refreshMarkReminder(w.state.unmarked);
    w.mark();
    const t = w.clock.now;
    for (let i = 0; i < 20; i++) w.clock.at(t + i * 50, () => (i % 2 ? w.lib.wontUpload() : w.lib.toggle()));
    w.clock.at(t + 1000, async () => {
      w.metrics.signOutCancelMs = await w.lib.signOut();
      // A late queue settle after sign-out must not re-arm.
      w.lib.refreshCountsSoon();
    });
    w.expectNothingScheduled = true;
  },
};

async function runScenario(name, fn, seed, profileName) {
  const w = makeWorld(seed, profileName);
  w.metrics = {};
  let markCalls = {};
  let markT = 0;
  let markBusy = 0;
  w.mark = () => {
    markCalls = { ...w.calls };
    markT = w.clock.now;
    markBusy = w.nativeBusy();
  };
  w.mark();
  const lastActivity = { t: 0 };
  const done = (async () => {
    await fn(w);
  })();
  await Promise.all([done, w.clock.run()]);
  lastActivity.t = w.clock.now;
  const delta = {};
  for (const [k, v] of Object.entries(w.calls)) {
    const d = v - (markCalls[k] ?? 0);
    if (d) delta[k] = d;
  }
  const nativeCalls = Object.entries(delta)
    .filter(([k]) => !k.startsWith('sql.'))
    .reduce((a, [, v]) => a + v, 0);
  const expectedBody = w.expectNothingScheduled
    ? undefined
    : w.state.unmarked === 1
      ? '1 photo in your library still needs a Back up or Won’t upload decision.'
      : `${w.state.unmarked} photos in your library still need a Back up or Won’t upload decision.`;
  const finalBody = w.os.scheduled.get('nightly-mark-reminder');
  return {
    nativeCalls,
    calls: delta,
    settleMs: lastActivity.t - markT, // until every queued native/SQL call has finished
    nativeBusyMs: w.nativeBusy() - markBusy,
    signOutCancelMs: w.metrics.signOutCancelMs,
    correct: finalBody === expectedBody && w.os.violations.length === 0,
    finalBody: finalBody ?? null,
    violations: w.os.violations,
  };
}

const out = { impl, runs: RUNS, profiles: PROFILES, libraryCountsMs: LIBRARY_COUNTS_MS, results: [] };
for (const profileName of Object.keys(PROFILES)) {
  console.log(`\n[${impl}] profile: ${profileName}`);
  for (const [name, fn] of Object.entries(SCENARIOS)) {
    const runs = [];
    for (let s = 1; s <= RUNS; s++) runs.push(await runScenario(name, fn, s * 7919, profileName));
    const r = {
      profile: profileName,
      scenario: name,
      nativeCalls: median(runs.map((x) => x.nativeCalls)),
      settleMs: median(runs.map((x) => x.settleMs)),
      nativeBusyMs: median(runs.map((x) => x.nativeBusyMs)),
      signOutCancelMs: runs[0].signOutCancelMs === undefined ? null : median(runs.map((x) => x.signOutCancelMs)),
      callsByName: Object.fromEntries(
        [...new Set(runs.flatMap((x) => Object.keys(x.calls)))].sort().map((k) => [k, median(runs.map((x) => x.calls[k] ?? 0))])
      ),
      allCorrect: runs.every((x) => x.correct),
      violations: [...new Set(runs.flatMap((x) => x.violations))],
    };
    out.results.push(r);
    console.log(
      `  ${name.padEnd(66)} native calls ${String(r.nativeCalls).padStart(4)}  ` +
        `native busy ${r.nativeBusyMs.toFixed(0).padStart(5)} ms  settled after ${r.settleMs.toFixed(0).padStart(5)} ms` +
        (r.signOutCancelMs === null ? '' : `  sign-out cancel ${r.signOutCancelMs.toFixed(0)} ms`) +
        `  ${r.allCorrect ? 'final state OK' : 'FINAL STATE WRONG ' + r.violations.join('; ')}`
    );
    console.log(`      ${JSON.stringify(r.callsByName)}`);
  }
}
const outDir = path.join(APP_DIR, 'bench/tap/out');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, `chain-${impl}.json`), JSON.stringify(out, null, 2));
console.log(`\nwrote bench/tap/out/chain-${impl}.json`);
