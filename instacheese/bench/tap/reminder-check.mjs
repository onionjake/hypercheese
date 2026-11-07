// Behaviour checks for mark-reminder.ts — the guarantees its comments
// document — run against the baseline and the current code alike, so the fix
// is shown to leave every outcome unchanged. Exit code 1 on failure.
//
//   node bench/tap/reminder-check.mjs [--impl=baseline|current|both]
import { loadTs, parseArgs } from './lib/load-ts.mjs';

const args = parseArgs(process.argv.slice(2));
const impls = (args.impl ?? 'both') === 'both' ? ['baseline', 'current'] : [args.impl];
const tick = () => new Promise((r) => setImmediate(r));
const BODY = (n) =>
  n === 1
    ? '1 photo in your library still needs a Back up or Won’t upload decision.'
    : `${n} photos in your library still need a Back up or Won’t upload decision.`;

function world(impl) {
  const w = {
    session: { baseUrl: 'x', mode: 'token', token: 't' },
    settings: { nightlyMarkReminder: true },
    granted: true,
    unmarked: 7,
    scheduled: new Map(),
    channel: false,
    log: [],
    failNextSchedule: false,
    handler: null,
  };
  const native = async (name, effect) => {
    w.log.push(name);
    await tick();
    await tick();
    return effect();
  };
  const Notifications = {
    AndroidImportance: { DEFAULT: 3 },
    SchedulableTriggerInputTypes: { DAILY: 'daily' },
    setNotificationHandler: (h) => (w.handler = h),
    getPermissionsAsync: () => native('perm', () => ({ granted: w.granted, canAskAgain: true })),
    requestPermissionsAsync: () => native('request', () => ({ granted: (w.granted = true) })),
    cancelScheduledNotificationAsync: (id) => native('cancel', () => w.scheduled.delete(id)),
    setNotificationChannelAsync: () => native('channel', () => (w.channel = true)),
    scheduleNotificationAsync: (req) =>
      native('schedule', () => {
        if (w.failNextSchedule) {
          w.failNextSchedule = false;
          throw new Error('boom');
        }
        if (!w.channel) throw new Error('schedule before channel');
        if (req.trigger.type !== 'daily' || req.trigger.hour !== 21 || req.trigger.channelId !== 'mark-reminder') {
          throw new Error('wrong trigger');
        }
        w.scheduled.set(req.identifier, req.content.body);
      }),
  };
  w.mod = loadTs('src/lib/mark-reminder.ts', impl, {
    'expo-media-library/legacy': { getPermissionsAsync: async () => ({ granted: false }) },
    'expo-notifications': Notifications,
    'react-native': { Platform: { OS: 'android' } },
    './auth': { loadStoredSession: () => native('session', () => w.session) },
    './library-db': {
      libraryCounts: () => native('counts', () => ({ unmarked: w.unmarked })),
      refreshFromLibrary: async () => {},
    },
    './log': { log() {}, logError() {} },
    './settings': {
      getSettings: async () => w.settings,
      updateSettings: async (c) => Object.assign(w.settings, c),
    },
    './upload-protocol': { MEDIA_PERMISSIONS: [] },
  });
  w.body = () => w.scheduled.get(w.mod.REMINDER_ID);
  w.calls = (name) => w.log.filter((x) => x === name).length;
  return w;
}

const TESTS = {
  'foreground handler suppresses banner/list/sound/badge': async (w) => {
    const h = await w.handler.handleNotification();
    return !h.shouldShowBanner && !h.shouldShowList && !h.shouldPlaySound && !h.shouldSetBadge;
  },
  'refresh schedules the count; channel created before schedule': async (w) => {
    await w.mod.refreshMarkReminder(5);
    return w.body() === BODY(5) && w.log.indexOf('channel') < w.log.indexOf('schedule');
  },
  'refresh() without a count reads the catalog': async (w) => {
    await w.mod.refreshMarkReminder();
    return w.body() === BODY(7);
  },
  'singular wording for 1': async (w) => {
    await w.mod.refreshMarkReminder(1);
    return w.body() === BODY(1);
  },
  'count dropping to 0 cancels the reminder': async (w) => {
    await w.mod.refreshMarkReminder(5);
    await w.mod.refreshMarkReminder(0);
    return w.body() === undefined;
  },
  'rapid refreshes end on the LAST count': async (w) => {
    const ps = [9, 8, 7, 6, 5].map((n) => w.mod.refreshMarkReminder(n));
    await Promise.all(ps);
    return w.body() === BODY(5);
  },
  'sign-out (session deleted, then cancel) while refreshes are queued: nothing left': async (w) => {
    const ps = [9, 8, 7].map((n) => w.mod.refreshMarkReminder(n));
    w.session = null;
    ps.push(w.mod.cancelMarkReminder());
    await Promise.all(ps);
    return w.body() === undefined;
  },
  'a refresh AFTER sign-out does not re-arm': async (w) => {
    await w.mod.refreshMarkReminder(5);
    w.session = null;
    await w.mod.cancelMarkReminder();
    await w.mod.refreshMarkReminder(5);
    await w.mod.refreshMarkReminder(6);
    return w.body() === undefined;
  },
  'a refresh in flight when sign-out starts: the later cancel wins': async (w) => {
    const p = w.mod.refreshMarkReminder(5); // starts now, reads the session first
    await tick();
    await tick();
    await tick();
    w.session = null;
    await Promise.all([p, w.mod.cancelMarkReminder()]);
    return w.body() === undefined;
  },
  'toggle-off cancels and later refreshes stay off; toggle-on re-arms': async (w) => {
    await w.mod.refreshMarkReminder(5);
    const p = w.mod.refreshMarkReminder(4);
    w.settings.nightlyMarkReminder = false;
    await Promise.all([p, w.mod.cancelMarkReminder()]);
    await w.mod.refreshMarkReminder(4);
    const off = w.body() === undefined;
    w.settings.nightlyMarkReminder = true;
    await w.mod.registerMarkReminder();
    return off && w.body() === BODY(7);
  },
  'same count after a cancel is scheduled again': async (w) => {
    await w.mod.refreshMarkReminder(5);
    await w.mod.cancelMarkReminder();
    await w.mod.refreshMarkReminder(5);
    return w.body() === BODY(5);
  },
  'a failed schedule is retried by the next refresh with the same count': async (w) => {
    w.failNextSchedule = true;
    await w.mod.refreshMarkReminder(5);
    const failed = w.body() === undefined;
    await w.mod.refreshMarkReminder(5);
    return failed && w.body() === BODY(5);
  },
  'no permission: nothing scheduled (no prompt from refresh)': async (w) => {
    w.granted = false;
    await w.mod.refreshMarkReminder(5);
    return w.body() === undefined && w.calls('request') === 0;
  },
  'cancel/schedule calls run strictly one at a time': async (w) => {
    let active = 0;
    let maxActive = 0;
    const orig = w.log.push.bind(w.log);
    w.log.push = (x) => {
      if (x === 'cancel' || x === 'schedule') {
        active++;
        maxActive = Math.max(maxActive, active);
        tick().then(tick).then(() => active--);
      }
      return orig(x);
    };
    await Promise.all([5, 4, 0, 3].map((n) => w.mod.refreshMarkReminder(n)).concat(w.mod.cancelMarkReminder()));
    await w.mod.refreshMarkReminder(2);
    return maxActive === 1 && w.body() === BODY(2);
  },
};

// Call-count expectations that only the fixed code meets (reported, and
// enforced for 'current').
const EFFICIENCY = {
  'unchanged count: a second refresh makes no native calls': async (w) => {
    await w.mod.refreshMarkReminder(5);
    const n = w.log.length;
    for (let i = 0; i < 10; i++) await w.mod.refreshMarkReminder(5);
    return { ok: w.log.length === n, detail: `${w.log.length - n} native calls for 10 unchanged refreshes` };
  },
  '20 refreshes issued at once run at most twice': async (w) => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => w.mod.refreshMarkReminder(30 - i)));
    return { ok: w.calls('schedule') <= 2 && w.body() === BODY(11), detail: `${w.calls('schedule')} schedules, ${w.log.length} native calls` };
  },
  'channel created once per process': async (w) => {
    for (const n of [5, 4, 3]) await w.mod.refreshMarkReminder(n);
    return { ok: w.calls('channel') === 1, detail: `${w.calls('channel')} channel calls for 3 schedules` };
  },
};

let failed = 0;
for (const impl of impls) {
  console.log(`\n[${impl}]`);
  for (const [name, t] of Object.entries(TESTS)) {
    const ok = await t(world(impl));
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  }
  for (const [name, t] of Object.entries(EFFICIENCY)) {
    const { ok, detail } = await t(world(impl));
    if (!ok && impl === 'current') failed++;
    console.log(`  ${ok ? 'ok  ' : impl === 'current' ? 'FAIL' : 'no  '} ${name} (${detail})`);
  }
}
console.log(failed ? `\n${failed} FAILED` : '\nall behaviour checks passed');
process.exit(failed ? 1 : 0);
