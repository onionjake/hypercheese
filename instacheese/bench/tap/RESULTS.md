# Backup-tab tap cost: before / after

Problem report: repeatedly selecting photos / marking "won't upload" on the
Backup tab while uploads run makes the app slow, then "app not responding",
then a crash (Android).

**Verdict: hypothesis confirmed, with one change.** Every tap really did run
a full-table `libraryCounts()` and then queue a complete
`refreshMarkReminder()` chain: settings read, Keystore decrypt, permission
check, cancel broadcast, channel IPC, schedule broadcast. Nothing was
coalesced, so 20 taps in 5 s queued 120 native calls (24 full chains,
including upload settles). The change: the expo-sqlite connection shared
with a running scan is **not** what makes taps wait. `withTransactionAsync`
is non-exclusive, so a tap waits at most for one in-flight statement. The
native queue the scan shares with the reminder chain *is* a head-of-line
bottleneck (see "Why this hurts on Android").

## How to rerun

```bash
cd instacheese
node bench/tap/sql-bench.mjs   --impl=baseline   # before (code at BASELINE_SHA)
node bench/tap/sql-bench.mjs   --impl=current    # after (working tree)
node bench/tap/chain-bench.mjs --impl=baseline
node bench/tap/chain-bench.mjs --impl=current
node bench/tap/check.mjs            # SQL equivalence + migration checks (exit 1 on failure)
node bench/tap/reminder-check.mjs   # mark-reminder guarantees, baseline vs current
```

Nothing is installed: the scripts use node 22's built-in `node:sqlite` and
the `typescript` package already in `node_modules`. Raw output is in
`bench/tap/out/` (`*.json` and `*.txt`).

## Method

* **Real code, not copies.** `lib/load-ts.mjs` transpiles `src/lib/*.ts`
  with TypeScript and runs it with every import mocked. `--impl=baseline`
  reads the file from git at `BASELINE_SHA = a1122398…` (the code before this
  work); `--impl=current` reads the working tree. The SQL strings,
  migrations, coalescing and serialization logic being measured are the
  app's own.
* **SQL (`sql-bench.mjs`).** An expo-sqlite-shaped shim over `node:sqlite`
  (`lib/sqlite-shim.mjs`; SQLite 3.53.4 here, expo-sqlite 57 vendors 3.50.3),
  on a WAL file database. `temp_store=MEMORY` matches expo-sqlite's
  `SQLITE_TEMP_STORE=2`. There is no `ANALYZE`, because the app never runs
  it. Synthetic catalogs of 5k / 20k / 60k rows (`lib/catalog.mjs`, seeded)
  are created through `library-db.ts`'s own `openDb()`. The run measures 3
  warm-ups and then 25 iterations per operation (10 for the heavy ones), and
  reports the median and p90. Mutating operations restore the row, untimed,
  after each iteration. `EXPLAIN QUERY PLAN` is captured from the statements
  the module actually ran. The bench also times a full `runScan` of an
  unchanged library, and taps issued while that scan is running.
* **Native chain (`chain-bench.mjs`).** Loads the real `mark-reminder.ts` +
  `settings.ts`. expo-notifications, SecureStore (through `./auth`),
  expo-file-system and `libraryCounts` are replaced by counters, and the
  harness replays `library.tsx`'s exact call pattern on a virtual clock:
  * `toggle` = `setSelected` → `refreshCounts()`
  * `markWontUpload` = `setExcluded` → `removeQueued` → `refreshCounts()`
  * queue settles = `refreshCountsSoon()` with a 500 ms debounce
  * `refreshCounts` = `await libraryCounts(); refreshMarkReminder(n)`, not awaited

  All native calls go through **one serial queue**, which models expo-modules'
  single `expo.modules.AsyncFunctionQueue` thread. SQL goes through a second
  queue (the connection). Each scenario runs with 7 seeds (±30 % latency
  jitter), and the tables report medians. Each run also checks the
  **final** OS state: the scheduled body equals the last count, nothing
  remains scheduled after sign-out, and the channel exists before any
  schedule.
* **Behaviour (`reminder-check.mjs`).** Runs 14 guarantee tests against
  both versions. All pass on both; the three call-count tests pass only on
  the fixed version.

### Catalog distribution (assumption)

| Property | Value |
|---|---|
| Creation times | Spread over 8 years; 2 % share a timestamp with the previous photo (bursts) |
| Media type | 10 % video |
| Unsupported | 2 % |
| Status | synced 60 %, excluded 7.5 %, pending 2 %, failed 0.5 %, the rest unmarked (~30 %) |
| Selected | 40 checked photos |
| Missed by last scan | 0.2 % |
| URIs | Android `content://media/...` |

### Latency assumptions for the native chain

These are **not device measurements**. Call **counts** don't depend on
them. Latencies only change how much coalescing happens.

| Call | nominal (ms) | congested (×4) |
|---|---|---|
| SecureStore get / delete (Keystore decrypt) | 15 | 60 |
| Notifications.getPermissionsAsync | 3 | 12 |
| cancelScheduledNotificationAsync (broadcast + AlarmManager + prefs) | 25 | 100 |
| setNotificationChannelAsync | 5 | 20 |
| scheduleNotificationAsync (broadcast + AlarmManager + prefs) | 30 | 120 |
| FileSystem read | 3 | 12 |
| MediaLibrary.getAssetsAsync, one 500-asset scan page (scan scenario only) | 250 | 1000 |
| libraryCounts at 60k rows | before 73 / after 12 | same |

`congested` stands for the same calls while uploads keep the native queue
and main thread busy. The `libraryCounts` figures are this machine's
measured 60k medians (24.3 / 4.0 ms) ×3, an **assumed** phone factor.

## Results: SQL (median ms, this machine; device will be slower)

| Operation | 5k before | 5k after | 20k before | 20k after | 60k before | 60k after |
|---|---|---|---|---|---|---|
| **libraryCounts** (every tap + settle) | 2.02 | 0.38 | 8.54 | 1.48 | **25.40** | **4.20** |
| tap: setSelected (1 id) | 0.20 | 0.32 | 0.29 | 0.33 | 0.21 | 0.31 |
| **tap: toggle = setSelected + libraryCounts** | 2.53 | 0.75 | 9.07 | 1.81 | **25.92** | **4.86** |
| tap: setExcluded (won't upload) | 0.20 | 0.34 | 0.31 | 0.32 | 0.35 | 0.34 |
| tap: markForUpload (1 id) | 0.22 | 0.35 | 0.36 | 0.31 | 0.36 | 0.33 |
| excludeSelected (40 checked) | 0.85 | 1.04 | 1.36 | 1.64 | 1.69 | 1.74 |
| settle: markStatus synced | 0.13 | 0.25 | 0.17 | 0.15 | 0.16 | 0.19 |
| **excludedAssetIds** (every drain batch) | 0.40 | 0.31 | 1.93 | 0.74 | **5.62** | **2.23** |
| isExcluded | 0.01 | 0.01 | 0.01 | 0.01 | 0.01 | 0.01 |
| markedForSync() | 0.42 | 0.43 | 1.63 | 1.62 | 5.58 | 5.88 |
| markedForSync(auto retry) | 0.36 | 0.37 | 1.45 | 1.49 | 5.33 | 5.62 |
| markedForSync(includeSynced) | 10.66 | 11.09 | 49.84 | 45.77 | 175.24 | 159.80 |
| **listAssets(unmarked) page 1** | 0.57 | 0.20 | 2.40 | 0.21 | **6.59** | **0.20** |
| listAssets(all) page 1 | 0.22 | 0.22 | 0.21 | 0.21 | 0.22 | 0.22 |
| listAssets(selected) page 1 | 0.16 | 0.15 | 0.15 | 0.16 | 0.15 | 0.16 |
| listAssets(synced) page 1 | 0.69 | 0.19 | 2.73 | 0.20 | 7.59 | 0.19 |
| listAssets(failed) page 1 | 0.12 | 0.10 | 0.24 | 0.20 | 0.31 | 0.20 |
| listAssets(excluded) page 1 | 0.25 | 0.20 | 0.26 | 0.20 | 0.26 | 0.19 |
| listAssets(unmarked) deep page (80 % down) | 0.60 | 0.22 | 2.31 | 0.21 | 6.52 | 0.21 |
| listAssets(all) deep page | 0.64 | 0.23 | 1.93 | 0.23 | 5.26 | 0.23 |
| listAssets(excluded) deep page | 0.49 | 0.20 | 1.98 | 0.21 | 4.03 | 0.21 |

Every read returns identical results before and after: the result digests
match, and `check.mjs` fuzzes counts, full keyset pagination of every filter,
`excludedAssetIds` and `markedForSync` over catalogs scrambled into every
mark combination.

### runScan and taps during a scan (shared connection)

| | 5k before | 5k after | 20k before | 20k after | 60k before | 60k after |
|---|---|---|---|---|---|---|
| Full rescan of unchanged library (ms) | 28 | 39 | 130 | 165 | 389 | **481** |
| Longest single statement during the scan (ms) | 2.4 | 4.3 | 20.8* | 7.1 | 7.2 | 8.4 |
| Tap (setSelected + counts) during scan, median (ms) | 2.4 | 0.75 | 9.0 | 1.8 | 26.2 | 4.4 |
| Tap during scan, max (ms) | 4.5 | 3.5 | 11.3 | 4.9 | 41.5 | 8.7 |

\* A one-off outlier, probably a WAL checkpoint.

The cost of the new indexes shows up here: a rescan is about 24 % slower
because every scanned row's index entries are rewritten. A tap during a scan
waits only for the statement in flight (≤ ~8 ms here), never for the whole
transaction. A tap's DB work during a scan is dominated by its own
`libraryCounts`, which is now ~6× cheaper.

The first open of an existing 60k catalog builds the new indexes once
(73 ms here). After that, opening costs ~5 ms (`check.mjs`).

### Query plans (60k)

| Query | Before | After |
|---|---|---|
| libraryCounts | `SCAN assets` (8 SUM expressions per row) | `SCAN assets USING COVERING INDEX idx_assets_marks` (GROUP BY, folded in JS) |
| excludedAssetIds | `SCAN assets` | `SCAN assets USING COVERING INDEX idx_assets_excluded` (partial) |
| listAssets(unmarked / synced / failed) | `SEARCH … idx_assets_status (status=?)` + `USE TEMP B-TREE FOR ORDER BY` (sorts all ~18k / ~36k matching rows) | `SEARCH … idx_assets_status_creation (status=?)`, no sort; stops after LIMIT |
| … deep page | same full sort | `SEARCH … idx_assets_status_creation (status=? AND (creation_time,id)<(?,?))` |
| listAssets(all) deep page | `SCAN … idx_assets_creation` from the newest photo (the OR blocks a range) | `SEARCH … idx_assets_creation (creation_time<?)` |
| listAssets(excluded) | `SCAN … idx_assets_creation` + sort | `SCAN` / `SEARCH … idx_assets_excluded ((creation_time,id)<(?,?))` |
| markedForSync | `idx_assets_status` + temp B-tree | `idx_assets_marks (status=? AND excluded=? AND supported=?)` + temp B-tree (same cost) |
| setSelected / setExcluded / markForUpload / markStatus / isExcluded | PK `sqlite_autoindex_assets_1 (id=?)` | unchanged |

Two candidates were tried and rejected (scratch experiments):

* **Covering index for the original SUM query, without the GROUP BY.** It
  was only 10 % faster: the cost is per-row expression evaluation.
* **An index led by `missing_since`.** The planner then chose it for
  `listAssets(all)`, making that 0.14 → 18 ms.

## Results: native call chain

### Per tap (nominal profile)

| | Native calls before | Native calls after | Reminder idle after the tap, before → after |
|---|---|---|---|
| 1 toggle, first refresh since app start | 6 | 6 | 161 → 92 ms |
| **1 toggle, reminder already scheduled (the normal case)** | **5** | **0** | 145 → 0 ms |
| 1 won't-upload (count changes) | 5 | 4 (no channel IPC) | — |

### 20-tap bursts (medians of 7 runs)

| Scenario | Profile | Native calls (before → after) | Native busy ms (before → after) | Reminder idle after last tap, ms (before → after) | tap→counts ms (before → after) | Sign-out cancel ms (before → after) |
|---|---|---|---|---|---|---|
| 20 toggles in 5 s + 4 upload settles | nominal | **120 → 0** | 1859 → 0 | 1105 → 0 | 75 → 13 | |
| 20 toggles in 5 s + 4 upload settles | congested | **120 → 0** | 7433 → 0 | 2773 → 0 | 75 → 16 | |
| 20 won't-upload in 5 s + 4 settles | nominal | 120 → 80 | 1844 → 1441 | 1107 → 84 | 83 → 14 | |
| 20 won't-upload in 5 s + 4 settles | congested | 120 → 72 | 7549 → 5251 | 2883 → 523 | 81 → 23 | |
| 20 won't-upload in 5 s during a library scan | nominal | 100 → 52 | 1559 → 966 | 1864 → 820 | 79 → 15 | |
| 20 won't-upload in 5 s during a library scan | congested | 100 → **12** | 6283 → 879 | 7619 → 2496 | 85 → 24 | |
| 20 taps in 1 s, then sign-out | nominal | 70 → 42 | 1125 → 779 | 731 → 651 | 298 → 14 | 75 → 54 |
| 20 taps in 1 s, then sign-out | congested | 34 → 18 | 2226 → 1347 | 1524 → 981 | 335 → 20 | **753 → 220** |

Native calls per 20-tap burst, broken down (nominal, 20 toggles + 4
settles):

| Version | SecureStore get | getPermissions | cancel | setChannel | schedule |
|---|---|---|---|---|---|
| Before | 24 | 24 | 24 | 24 | 24 |
| After | 0 | 0 | 0 | 0 | 0 |

For 20 won't-upload: before 24 of each; after 20 / 20 / 20 / 0 / 20.

Every scenario ended in the correct final state in every run, before and
after. In the congested baseline, "native busy" (7.4–7.5 s for a 5 s burst)
exceeds wall time: the shared native queue is saturated and backs up, which
is the mechanism behind the reported slowdown.

## Why this hurts on Android (from the native sources in node_modules)

* `expo-modules-core` `AppContext.kt` (~lines 71–92) runs every
  `AsyncFunction` without an explicit queue on **one**
  `HandlerThread("expo.modules.AsyncFunctionQueue")`. That covers
  SecureStore, notifications permission/channel/schedule dispatch, legacy
  file-system reads and writes (log flushes) and media-library
  `getAssetsAsync` (a whole scan page). expo-sqlite opts out
  (`runOnQueue(Dispatchers.IO)`), which is why the SQL side doesn't block
  that thread.
* `expo-notifications` `NotificationScheduler.kt` / `NotificationsService.kt`:
  * Each `scheduleNotificationAsync` and `cancelScheduledNotificationAsync` is
    an **explicit broadcast** (`doWork` → `sendBroadcast`) that goes through
    system_server.
  * The receiver does AlarmManager IPC plus `SharedPreferences.apply()`.
  * The `ResultReceiver` that resolves the JS promise posts to
    `Looper.getMainLooper()`.

  Pending `apply()` writes are flushed by `QueuedWork.waitToFinish()` **on
  the main thread** when the activity pauses or stops: a known ANR path.
  Baseline produced 2 broadcasts + 2 prefs writes per tap. After the fix, a
  selection tap produces none.

None of this was run on a device. It is code reading, and the chain
benchmark models it.

## What changed

### `src/lib/mark-reminder.ts` (all documented guarantees kept; `reminder-check.mjs`)

1. **Coalescing.** A refresh that is still waiting its turn absorbs later
   calls; the latest count wins. At most one refresh runs and one waits.
2. **Skip unchanged.** The module tracks what it last left scheduled
   (`scheduledBody`; *unknown* at process start and after any failure). A
   refresh whose result would equal that skips everything, gates included.
   Re-running could only cancel and re-schedule identical content, or bail
   on a gate and leave it alone, so the outcome is unchanged. Sign-out and
   toggle-off still always cancel (their `cancelMarkReminder` records
   "nothing scheduled").
3. **Cancel drops a queued (not started) refresh.** A refresh followed by a
   cancel ends with nothing scheduled either way. The cancel still runs
   serialized after any refresh in flight, so it still wins, and it now
   waits behind fewer chains (sign-out cancel 753 → 220 ms, congested).
4. **Android channel created once per process**, still before the first
   schedule. Nothing in the app deletes it, and users can't delete a
   channel.

The foreground handler and the refresh-after-sign-out session check are
unchanged.

### `src/lib/library-db.ts`

* **Migration.** New indexes are added in `openDb()` with
  `CREATE INDEX IF NOT EXISTS`, *after* the column ALTERs, because they index
  `excluded` and `missing_since`. `idx_assets_status` is dropped (superseded
  by `idx_assets_status_creation`). This is safe for existing installs,
  including pre-"won't upload" catalogs (tested in `check.mjs`).
  * `idx_assets_marks (status, excluded, supported, selected, missing_since)`
  * `idx_assets_status_creation (status, creation_time DESC, id DESC)`
  * `idx_assets_excluded (creation_time DESC, id DESC) WHERE excluded = 1`
* **`libraryCounts`** uses `GROUP BY status, excluded, supported, selected`
  (≤ 32 groups) and folds the result in JS, with the same conditions as
  before.
* **`listAssets` keyset** uses `(creation_time, id) < (?, ?)`. This is
  equivalent to the old OR, since both columns are NOT NULL, and it is
  index-seekable.

### `src/lib/settings.ts`

No change needed: `getSettings()` is already memory-cached after the first
read (1 file read per process).

## Recommended `library.tsx` call-site changes (not made; another agent owns the file)

1. `toggle()` changes only `selected` / `backupReady`, never `unmarked`, so
   the reminder is now free for it. It still runs a full `libraryCounts()`
   plus a `setCounts` re-render per tap. Use the existing debounced
   `refreshCountsSoon()` (or a shorter ~150–250 ms variant) from `toggle`,
   `markWontUpload` and `markForUploadNow` instead of `refreshCounts()`.
   Rows are already updated optimistically via `setAssets`. Alternatively,
   adjust `counts.selected` / `counts.backupReady` locally on toggle.
2. No change is needed in how `refreshMarkReminder` is called. Fire-and-forget
   per refresh is fine now that the module coalesces and skips.

## Caveats

* No device numbers: SQL times are a desktop CPU, and native latencies are
  stated assumptions. The robust results are the call counts, the query
  plans, and the before/after ratios.
* The node:sqlite shim omits expo-sqlite's per-call JSI/native hop (prepare
  → execute → finalize), which adds a fixed cost per statement on device.
  That favours fewer statements but doesn't change any plan.
* The skip-unchanged record could go stale only if something outside
  `mark-reminder.ts` removed the scheduled reminder while the process lives.
  Nothing in the app does: a grep finds no other `expo-notifications`
  schedule or cancel calls. A new process starts from *unknown*.
* Won't-upload taps still cost 4 native calls each when they arrive slower
  than a chain runs, because the count really changes. Caching the session
  or permission read was considered and **not** done: a cached
  "signed in" would weaken the refresh-after-sign-out guarantee.
* Unrelated observation: expo-sqlite's `withTransactionAsync` is
  non-exclusive, so a tap's write issued mid-scan becomes part of that scan
  page's transaction and would be rolled back if the page failed. This is a
  correctness note, not a performance one, and was left as is.
