# Backup grid render benchmark

Reproduces the report "selecting photos / marking won't upload on the Backup
tab while uploads run makes the app unresponsive (Android: app not
responding), then it crashes". It measures how much work
`src/app/(tabs)/library.tsx` does on the JS thread, and asks of the native
side, for each upload-queue event and each user action.

## Running it

```bash
cd instacheese
node bench/grid/run.js --rev 68288ed --label before --out bench/grid/results/before.json  # pre-fix screen
node bench/grid/run.js --label after --out bench/grid/results/after.json                   # working tree
node bench/grid/compare.js bench/grid/results/before.json bench/grid/results/after.json    # Markdown table
```

Options: `--reps N` (default 15) and `--warmup N` (3) for the small
scenarios; `--batch-reps N` (5, after 1 warm-up) for the big batch scenarios;
`--loaded N` (1000) assets to page in; `--catalog N` (2000) fake camera-roll
size. `--rev <git rev>` benchmarks `library.tsx` as of that revision; only
that file changes, the rest of the harness is the same. `68288ed` is the
last commit before this work touched the screen. A full run takes 2–3 minutes,
most of it in the pre-fix drain-batch scenario.

Nothing is installed. Everything comes from `instacheese/node_modules`, run on
Node 22.

## Method

- **Renderer:** `react-dom/profiling`, the production build with Profiler
  timings. It renders into a ~200-line DOM shim (`dom-shim.js`). React Native
  host components (`View`, `Text`, `Pressable`, `ScrollView`) are mocks that
  render custom elements and carry their RN props (`mocks/react-native.js`).
  Like the real components, `Pressable` is `memo`, and expo-image's `Image`
  and the Ionicons are `PureComponent`s.
- **The list is real.** `FlatList` is React Native's own (0.86 when these
  results were recorded) `Libraries/Lists/FlatList.js` on the real
  `@react-native/virtualized-lists`.
  Both are transpiled from their Flow sources. This keeps the behaviour this
  investigation depends on: windowing, `numColumns` row grouping (a fresh row
  array and a non-memoized renderer on every FlatList render, plus
  joined-key rows), `CellRenderer` purity and the batching timers.
- **App code goes through the production Babel pipeline.** `loader.js`
  transpiles it with `babel-preset-expo` as Metro calls it for a release
  Android/Hermes build, including the React Compiler, because `app.json`
  sets `experiments.reactCompiler`. The run prints the compiler's verdict
  per component.
- **Native layout is simulated** for a 412×650dp list viewport (a typical
  phone; 3 columns, so rows are 137.3dp). After every commit the harness
  fires `onLayout` for cells whose frame changed and
  `onContentSizeChange`/`onScroll` as Fabric would, including clamping the
  scroll offset when the content shrinks. The VirtualizedList therefore
  windows exactly as it would on a device.
- **The data and the queue are in-memory fakes** (`mocks/app/`). The fake
  catalog keeps library-db's paging order and filter meanings, and the fake
  queue keeps upload-queue's subscribe API. Every fake native call
  (expo-sqlite, file stat, network) resolves about 1ms later on a timer, as
  a JSI async call does, so the app's `await`s split work into separate
  React batches the way they do on a device. Those waits count as idle time.
- **Setup:** mount the screen and scroll down until ~1,000 assets are paged
  in (onEndReached loads 120 at a time). Then park in the middle (row 180),
  which mounts a full window above and below.
- **Metrics** are medians over the repetitions, after warm-up:
  - *JS busy ms* is `performance.eventLoopUtilization().active` from the
    trigger until the app is idle again (no commits, no fake native calls or
    app timers pending). It covers the app's own code, React render and
    commit, and the harness's small per-turn overhead. Idle waits (fake
    native latency, debounces, frames) are excluded. The `noop` row is the
    floor.
  - *React render ms* is the sum of Profiler `actualDuration`: render-phase
    time of the screen subtree only.
  - *Commits* are React commits. *Screen*, *row* and *cell renders* count
    executions of `LibraryScreen`, of VirtualizedList's `CellRenderer` (one
    per grid row) and of the cell body (the checkbox `Pressable`).
  - *Host prop updates* count host instances React re-committed with new
    props. On Fabric each one is a shadow-node clone, a props diff and,
    when anything differs, a mount-item on the UI thread.
  - *Image mounts / unmounts* count expo-image `Image` components created and
    destroyed. On Android each mount is a native `ExpoImageViewWrapper` plus
    a Glide request; each unmount tears one down.

## Scenarios

| Scenario | What happens |
|---|---|
| item event, visible asset | One `emitItem('hashing')` for an on-screen photo whose badge changes (none → pending). |
| item event, asset not loaded | One `emitItem` for a photo not in the loaded list. This is the common case in Unmarked: Back up reloads the list, and marked photos leave it. |
| 'checking' burst x200 | The drain marks a batch: 200 `emitItem('checking')` in one synchronous loop (upload-queue.ts ~968). The rows are already pending, as they are after Back up. |
| burst x200, all rows change | Stress variant: 200 back-to-back events that all change a badge. |
| summary change only | A queue summary broadcast with a new current file or phase, and no item change. |
| one file upload cycle | `setCurrent` + `setItemStatus` for hashing and uploading, 2 progress ticks, then `settle(done)` + summary, then the 500ms chip-count debounce. Steps are more than one frame apart. |
| tap (select toggle) | `onPress` on a visible cell runs `setSelected`, `setAssets`, then counts. |
| won't upload (long-press) | `onLongPress`, then the Alert's "Won't upload" button: `setExcluded`, `removeQueued`, `setAssets`, then counts. |
| drain batch of 200 (all exist) | A whole drain batch the server already has: the 'checking' burst, then per item a size resolve (`setCurrent` broadcast + 3 native calls), the manifest, then per item `settle('exists')` (3 native calls + `emitItem` + summary). |
| enqueue re-trigger, 1000 items | An auto-retry/foreground re-enqueue of 1,000 pending backup rows (not in the list): 1,000 `emitItem('queued')`, yielding every 200 (upload-queue.ts ~429-453). |
| Back up 16 selected (top) | Triage at the top of Unmarked: 16 photos in the first 11 rows are selected (by tapping), then Back up. Unmarked reloads, the 16 drop out and every later photo shifts. |

## Results

Before: `library.tsx` at 68288ed. After: the working tree. Node 22.23, medians of 15 runs (5 for the two batch scenarios). Raw output is in `results/before.{json,txt}` and `results/after.{json,txt}`.

Mounted window: 333 → 132 cells (111 → 44 rows), 1080 assets loaded, viewport 412x650dp, scrolled to row 180.

| Scenario | JS busy ms (median) | React render ms (median) | Commits | Screen renders | Row renders | Cell renders | Host prop updates | Image mounts / unmounts |
|---|---|---|---|---|---|---|---|---|
| noop (harness floor) | 0.02 → 0.01 | 0.00 → 0.00 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0/0 → 0/0 |
| item event, visible asset | 10.8 → 3.69 | 4.35 → 0.88 | 2 → 2 | 1 → 1 | 111 → 44 | 333 → 1 | 1312 → 123 | 0/0 → 0/0 |
| item event, asset not loaded | 6.55 → 0.47 | 2.77 → 0.00 | 2 → 0 | 1 → 0 | 111 → 0 | 333 → 0 | 1320 → 0 | 0/0 → 0/0 |
| 'checking' burst x200 | 11.1 → 0.68 | 6.34 → 0.00 | 2 → 0 | 1 → 0 | 111 → 0 | 333 → 0 | 1520 → 0 | 0/0 → 0/0 |
| burst x200, all rows change | 14.3 → 6.17 | 7.05 → 2.37 | 2 → 2 | 1 → 1 | 111 → 44 | 333 → 102 | 1720 → 544 | 0/0 → 0/0 |
| summary change only | 7.13 → 0.63 | 2.97 → 0.15 | 2 → 1 | 1 → 1 | 111 → 0 | 333 → 0 | 1521 → 30 | 0/0 → 0/0 |
| one file upload cycle | 53.1 → 13.4 | 19.5 → 2.34 | 10 → 7 | 7 → 6 | 666 → 88 | 1998 → 2 | 9127 → 313 | 0/0 → 0/0 |
| tap (select toggle) | 13.4 → 6.26 | 5.28 → 1.11 | 3 → 3 | 2 → 2 | 222 → 44 | 666 → 1 | 3046 → 159 | 0/0 → 0/0 |
| won't upload (long-press) | 14.7 → 6.28 | 5.39 → 1.06 | 3 → 3 | 2 → 2 | 222 → 44 | 666 → 1 | 3025 → 155 | 0/0 → 0/0 |
| drain batch of 200 (all exist) | 2273 → 106 | 1013 → 39.5 | 446 → 130 | 402 → 120 | 44622 → 1804 | 133866 → 204 | 608423 → 8219 | 0/0 → 0/0 |
| enqueue re-trigger, 1000 items | 38.4 → 0.85 | 22.4 → 0.00 | 6 → 0 | 5 → 0 | 555 → 0 | 1665 → 0 | 7555 → 0 | 0/0 → 0/0 |
| Back up 16 selected (top) | 8.44 → 3.04 | 1.98 → 1.16 | 3 → 3 | 2 → 2 | 80 → 19 | 240 → 57 | 525 → 263 | 120/159 → 0/0 |

## Findings

1. **Hypothesis confirmed: every queue event re-rendered the whole mounted grid.**
   Before the fix, one item event for a photo that isn't even in the list
   re-rendered all 333 mounted cells (111 rows) and re-committed about
   1,300 host views. A summary-only broadcast (new current file or phase) did
   the same. The causes:
   - `setAssets(prev => prev.map(...))` always returned a new array.
   - `renderItem`, `keyExtractor`, `onEndReached` and `ListEmptyComponent`
     were new on every screen render, so the `FlatList` (a `PureComponent`)
     re-rendered every time.
   - With `numColumns`, React Native's FlatList builds a fresh row array per
     row on every render and passes a new renderer, so every `CellRenderer`
     re-renders. The inline cell then rebuilt `Pressable`, `Image` and the
     icons with new closures and `source`/`accessibilityState` objects.
2. **The React Compiler wasn't saving it.** `app.json` enables it, but it
   skips `LibraryScreen` (the run prints the reason). The screen has an
   `eslint-disable … react-hooks/exhaustive-deps` suppression. Even without
   that, the compiler can't yet handle the `try/finally` in `loadPage` and
   `rescan`. The screen therefore ran completely un-memoized. The new
   `LibraryCell` *is* compiled.
3. **The upload drain is the ANR trigger.** A batch of 200 files the server
   already has (manifest hits, typical after a reinstall or a full sync)
   produced 402 full-grid renders:
   - 134k cell renders
   - 608k host prop updates
   - 2.3 s of JS busy time *on V8*

   On Hermes on a phone that is many seconds of JS thread, plus hundreds of
   thousands of Fabric commits on the UI thread. Taps queue behind it. After
   the fix: 204 cell renders, 8.2k host updates, 0.11 s.
4. **Re-enqueue storms.** An auto-retry or foreground re-enqueue with 1,000
   pending items cost 5 full-grid renders plus 1,000 × 1,080 `map`
   iterations, even though none of those photos is in the Unmarked list.
   After the fix it does no render at all.
5. **Remount cascade on batch actions.** FlatList keys a multi-column row by
   its items' keys joined together. Removing a non-multiple-of-3 number of
   photos near the top therefore re-keyed every later row. Back up with 16
   selected unmounted 159 and mounted 120 image views (with Glide requests)
   in one commit. With position keys, nothing is remounted: rows stay and
   cells receive their new photo (`recyclingKey` clears the old picture).
6. **Window size.** The default `windowSize` 21 kept 333 cells (111 rows)
   mounted mid-list. `windowSize` 7 with `getItemLayout` keeps 132. With
   Android's default `removeClippedSubviews`, off-screen cells are detached,
   not destroyed, and keep their bitmaps. Each is roughly 355×355 ARGB, about
   0.5 MB, so this is about 165 MB versus about 65 MB of thumbnail bitmaps
   held. (That is an estimate; memory isn't measured here.)
7. **Thumbnails / full-resolution originals.** expo-image 57 on Android
   downsamples to the view size when decoding (`allowDownscaling` defaults
   to true, using `ContentFitDownsampleStrategy`). The resident bitmap is
   therefore thumbnail-sized, not full-resolution, and an explicit size hint
   (`source.width`/`height`, which maps to Glide `override`) isn't needed.
   What did cost was the default `cachePolicy: 'disk'`, which sets Glide's
   `skipMemoryCache(true)`, so every remount decoded again. The grid now uses
   `cachePolicy="memory-disk"`; Glide's LRU memory cache is bounded.
   `decodeFormat="rgb"` would halve bitmap memory, but it causes visible
   banding, so it was left off now that the window is bounded.
8. **Taps.** A tap re-rendered 666 cells across its two commits (the
   selection change, then the chip counts). Now it re-renders 1 cell. The
   counts refresh after a tap is debounced by 200ms, so a run of quick taps
   costs one count query instead of one per tap (batch actions still
   refresh immediately).

## What changed

`src/app/(tabs)/library.tsx` and the new `src/components/library-cell.tsx`:

- `LibraryCell` is a memoized cell. `toggle`, `showDetails`,
  `markWontUpload`, `markForUploadNow` and `renderItem` are stable
  `useCallback`s, so only cells whose asset object changed re-render.
- Every `FlatList` prop is stable:
  - `keyExtractor` is a module-level function.
  - `onEndReached` reads the latest `loadPage`/`scanning` from a ref.
  - `ListEmptyComponent` is memoized.

  Summary and count updates therefore skip the grid entirely.
- Queue item events are queued per asset and applied once per animation
  frame in a single pass, in arrival order. The per-event mtime guard is kept,
  as `applyItemEvent`. When no loaded row changed, the updater returns the
  previous array, so React does no render at all. Summary broadcasts are
  applied at most once per frame too, with the same "fields this screen
  shows" equality check.
- Rows are keyed by position instead of joined asset ids, so batch actions
  and rescans no longer remount the window.
- `windowSize` is 7 (it was the default 21). `getItemLayout` uses rows that
  are one third of the list width tall: full rows of square cells with a 1dp
  margin. The width comes from the list's `onLayout`, falling back to the
  window width.
- The grid `Image` uses `cachePolicy="memory-disk"`.
- Single-photo actions refresh the chip counts on a 200ms debounce.

## Suggestions for upload-queue.ts (not changed here)

The screen now copes with event volume on its own. Every other subscriber
still pays per event, though, so the emitter could do less:

- **`enqueue`.** Skip `emitItem` for rows that were already active with the
  same mtime (`wasActive`), since nothing changed for them. Alternatively,
  emit one batched event with the list of keys.
- **Drain batches.** Mark a whole batch `'checking'` with one batched event
  instead of 200 individual ones.
- **`broadcastSummary`.** Each `settle` and `setCurrent` broadcasts. A
  per-frame throttle there (keeping the latest summary) would help every
  screen, not just this one.

## Caveats

- **Node/V8 is not Hermes on a phone.** V8 JIT-compiles this code. Hermes
  in a release build runs bytecode with no JIT, on a mobile CPU. The
  absolute milliseconds are therefore a *lower bound*, plausibly 5–20×
  below a mid-range Android phone. The before/after *ratios* and the *render
  and host-update counts* carry over: the same components run the same
  number of times on any engine.
- **Native cost is not measured.** The DOM shim's commit is nearly free.
  On Fabric, every host prop update is a shadow-tree clone and diff, and
  layout and mounting run on the UI thread. That cost can't be measured in
  Node, so the host-update and image mount/unmount columns stand in for it.
  Image decoding (Glide threads) and memory aren't modelled.
- **Frame coalescing depends on event cadence.** The fix applies queue
  events once per frame. The harness models a frame as a 16ms timer, and a
  fake native call as about 1ms. On a device, settles in a manifest-hit run
  may come faster or slower than that, so the drain-batch commit count after
  the fix is cadence-dependent. The grid work per commit does not depend on
  cadence. The upload-cycle scenario spaces its steps more than a frame
  apart, so it gets no credit for coalescing.
- The fake catalog and queue are cheap, so the JS busy time is almost all
  React plus screen code. On a device, expo-sqlite queries add their own
  time, but that is the same before and after.
- The first measured `onLayout` of the list also triggers one extra render
  in the fixed screen, to learn the list width. It happens during setup and
  isn't counted.

## Rerun under Expo SDK 58 (React Native 0.88, React 19.3)

`node bench/grid/run.js --label after --reps 5` after the SDK 58 upgrade:
the same scenarios and per-scenario commits, row/cell/icon renders and host
updates as `results/after.txt`, except that one file upload cycle now
re-renders 44 rows instead of 88 (and 217 host updates instead of 313).
Busy times are within run-to-run noise. The React Compiler results are
unchanged. The only harness change was to mock
`react-native/react-private-interface`, which virtualized-lists 0.88 reads
its feature flags through (`mocks/react-private-interface.js`).
