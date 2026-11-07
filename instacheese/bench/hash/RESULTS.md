# Big-file SHA-256: JS-thread blocking — before vs after

**Problem:** selecting photos or marking "won't upload" while uploads run makes
the app unresponsive (Android "app not responding"), then it crashes.

**Hypothesis:** confirmed. `sha256OfFile` hashed files over 24 MB by
synchronously reading 16 MiB (`FileHandle.readBytes`, a synchronous JSI call)
and hashing it with pure-JS js-sha256, yielding only between chunks. Without
a JIT, one chunk blocks the JS thread for about **6 s** on this machine
(Hermes on a phone: probably 3–30 s). A 1 GB video means about 64 freezes
like that, minutes in total. Taps, list updates and DB callbacks wait behind
each one.

**Fix:** `src/lib/hash-file.ts` (`sha256OfReader`, called from
`sha256OfFile`) reads 1 MiB at a time and hashes it in 16 KiB slices. It
checks the clock after each slice and yields once 20 ms of work has
built up. Longest block: **6223 ms → 30 ms** under the interpreter stand-in
(`--jitless`), **322 ms → 21 ms** with V8's JIT. Throughput is unchanged and
the hash is identical to node:crypto in every case tested, including a
file over 4 GiB.

**Library question:** switching pure-JS libraries does **not** help much
on Hermes. Libraries that run 2–3× faster than js-sha256 with a JIT run at
about the same speed without one, and the JIT favourite, @noble/hashes, is
**1.7× slower**. The app keeps js-sha256 and gets no new dependency. The big
remaining gain is native hashing (see the end).

## Method

- Machine: Intel Xeon @ 2.1 GHz (4 cores, SHA-NI), Node v22.23.4. No Hermes
  VM is available, so every case runs twice: **V8 (JIT)** and
  **`node --jitless`** (V8's Ignition interpreter only), which stands in for
  Hermes' interpreter.
- **Synthetic file, no disk:** the content is a deterministic 1 MiB + 7 byte
  pseudo-random pattern repeated to any size. `SyntheticFile.readBytes(n)`
  copies into a fresh `Uint8Array(n)` on every call, which models the
  fresh JS buffer that expo-file-system makes for each `readBytes`. The phone's
  native disk read is not modelled.
- **before** = the pre-fix loop copied verbatim (16 MiB reads, one `update`
  per chunk, yield after each chunk). **after** = the shipped
  `src/lib/hash-file.ts`, transpiled with the app's TypeScript, with the
  library injected for the comparison rows (the app uses js-sha256).
- "Block" = the time the JS thread runs without yielding: from start or the
  last resume to the next yield or the end. Yields are `setImmediate`
  promises, standing in for `yieldToUI`. Every run checks its hash against
  node:crypto.
- Medians: 5 runs (100 MiB, V8), 3 runs (1 GiB V8, and all `--jitless`).
  Each case runs in a fresh process.

## Before vs after (js-sha256, the shipped configuration)

| | engine | size | MB/s | **longest block** | p95 block | yields | reads | bytes per read |
|---|---|---|---|---|---|---|---|---|
| before | V8 (JIT) | 100 MiB | 56.3 | 295.6 ms | 295.6 ms | 7 | 7 | 16 MiB |
| before | V8 (JIT) | 1 GiB | 57.5 | 322.1 ms | 298.8 ms | 64 | 64 | 16 MiB |
| before | V8 --jitless | 100 MiB | 2.6 | **6223 ms** | 6223 ms | 7 | 7 | 16 MiB |
| after | V8 (JIT) | 100 MiB | 58.7 | 20.3 ms | 20.3 ms | 84 | 100 | 1 MiB |
| after | V8 (JIT) | 1 GiB | 59.5 | 21.0 ms | 20.3 ms | 853 | 1024 | 1 MiB |
| after | V8 --jitless | 100 MiB | 2.6 | **30.4 ms** | 24.4 ms | 1615 | 100 | 1 MiB |

Each read now allocates 1 MiB instead of 16 MiB: on Android that is a Java
`ByteArray` plus a JS `ArrayBuffer` copy per call. The total bytes allocated
are the same, but each live block of garbage is 16× smaller, which matters
for a Java heap of 256–512 MB and for Hermes' external-memory GC trigger.
Peak memory is not reported because V8's GC timing is not Hermes'.

### Slicing trade-off (js-sha256, `--jitless`, 32 MiB, 3 runs) — `--phase sweep`

| read | slice | budget | MB/s | longest block | p95 | yields |
|---|---|---|---|---|---|---|
| 1 MiB | 64 KiB | 25 ms | 2.65 | 50.7 ms | 48.5 ms | 263 |
| 1 MiB | 32 KiB | 25 ms | 2.58 | 45.6 ms | 37.1 ms | 353 |
| **1 MiB** | **16 KiB** | **20 ms** | 2.60 | **30.8 ms** | 25.2 ms | 517 (chosen) |
| 1 MiB | 16 KiB | 10 ms | 2.64 | 19.5 ms | 12.3 ms | 1025 |
| 1 MiB | 8 KiB | 10 ms | 2.63 | 15.9 ms | 12.4 ms | 1035 |
| 4 MiB | 16 KiB | 20 ms | 2.64 | 28.8 ms | 24.5 ms | 517 |
| 256 KiB | 16 KiB | 20 ms | 2.59 | 29.0 ms | 24.9 ms | 520 |

The longest block is about the budget plus one slice. Read size hardly
matters here, because only the copy is modelled; on the phone, smaller reads
also make the synchronous native read shorter. The budget is measured on
the device, so a slower phone yields more often. Only the slice time grows:
at 2× slower than this run, the longest block is about 20 + 12 ms plus one
1 MiB read. The 20 ms budget was chosen over 10 ms to halve the number of
yields: each foreground yield is a `setTimeout(0)` plus an AppState
subscription.

## Library comparison (pure JS) — `--phase libs` and `--phase after`

In-memory throughput, 32 KiB updates (64 MiB V8, 16 MiB `--jitless`, 5 runs),
plus each library running inside the shipped loop (100 MiB `--jitless`, 3 runs):

| library | V8 (JIT) MB/s | `--jitless` MB/s | in shipped loop, `--jitless`: MB/s / longest block | notes |
|---|---|---|---|---|
| **js-sha256** 0.11.1 (current) | 58.1 | 2.1–2.6 ¹ | 2.6 / 30.4 ms | already a dependency; 64-bit byte counter |
| @noble/hashes 2.4.0 | **169.9** | **1.4** | 1.5 / 36.4 ms | fastest with a JIT, slowest without: a `DataView` call per word |
| @stablelib/sha256 2.0.1 | 127.1 | 2.8 | 2.8 / 28.5 ms | ESM-only, 3 small deps |
| fast-sha256 1.3.0 | 129.3 | 2.9 | 2.9 / 33.0 ms | single file, last release 2020 |
| asmcrypto.js 2.3.2 | 147.2 | 3.3 | — | best without a JIT (+30%), but unmaintained, large, and copies input into its asm.js heap |
| @aws-crypto/sha256-js 5.2.0 | 78.2 | 2.1 | — | pulls in @aws-sdk/types and tslib |
| node-forge 1.4.0 | 41.7 | 2.2 | 2.2 / 31.8 ms | needs binary strings (conversion included) |
| crypto-js 4.2.0 | 44.7 | 2.2 | — | discontinued; WordArray conversion included |
| jssha 3.3.2 | 35.1 | 0.9 | — | |
| hash.js 1.1.7 | 26.2 | 1.0 | — | copies input into a plain Array |
| *node:crypto (OpenSSL, native)* | *1274* | *1262* | — | *one-shot 24 MiB, fresh buffer + copy + digest: 33–36 ms* |

¹ Run to run, js-sha256 ranged from 2.1 to 2.6 MB/s under `--jitless`. Repeated
8 MiB runs gave 2.56/2.64 MB/s, against @stablelib 2.85/2.83, fast-sha256
2.87/2.86, asmcrypto 3.42/3.36 and noble 1.51/1.51.

**Ranking for the phone** (no JIT): no maintained pure-JS library beats
js-sha256 by more than ~10%. The 2–3× gains seen in browsers and Node come
from the JIT and disappear on Hermes. @noble/hashes would be a 1.7× regression.
Because of this, and to avoid new dependencies, the app keeps js-sha256 and
`package.json` is unchanged. The comparison libraries live only in
`bench/hash/package.json`. WASM hashers (hash-wasm) can't run: Hermes has no
WebAssembly. `sha.js` needs Node's `Buffer` and was skipped.

## Estimating Hermes on a phone

- V8 JIT vs `--jitless` for js-sha256 is about **22×** (58 vs 2.6 MB/s), so
  Node's JIT numbers say nothing about the phone.
- Hermes' interpreter is assumed to be within roughly ±2× of V8's Ignition
  on this integer-heavy code. That is unverified, because no Hermes VM was
  available. A phone's big core is about 1–1.5× slower per thread than this
  2.1 GHz Xeon, and little cores are 3–4× slower.
- **Estimate:** js-sha256 on Hermes runs at **~0.5–3 MB/s**. **Before**,
  that means a 5–30 s freeze per 16 MiB chunk and **6–35 min** of JS-thread
  time for a 1 GB video. **After**, blocks are about 20 ms plus one slice
  (~5–30 ms), so ≲50 ms. The total hashing time stays the same, but it is
  interleaved with UI work.
- The ≤24 MB path is unchanged: `File.bytes()` (native read off-thread, then
  a copy into JS) plus `Crypto.digest`. On Android `Crypto.digest` is a
  **synchronous** native `Function("digest")` (expo-crypto, and
  in SDK 58 too), but native SHA-256 is about 1 GB/s with ARMv8 SHA
  instructions. Expect one block of about 15–40 ms per photo. The node:crypto
  stand-in measured 33–36 ms for 24 MiB, including allocation and copy. This
  is acceptable and much cheaper than any JS hash.

## Equivalence (`node bench/hash/equivalence.mjs`) — 1999 checks, 0 failures

The shipped `sha256OfReader` with js-sha256 was compared with node:crypto
(`results/equivalence.txt`):

- every size 0–300 bytes (covers 55/56/63/64/65 and the 119/120/128 padding
  edges), each with 6 slicings, including 1-byte reads and slices and
  odd sizes such as 7/63/65/333;
- 16 Ki, 32 Ki, 64 Ki, 1 Mi, 2 Mi, 16 Mi and 24 Mi bytes, each ±1, with the
  default and an odd slicing;
- 40 random sizes (up to 40 MiB) with the default and random slicings;
- short reads (the reader returns 1..n of the n bytes asked for), an
  over-long final read, and files longer than the recorded size, which hash
  exactly `size` bytes as before;
- a file shorter than `size` (empty, off by one, 30 MiB vs 7 MiB) throws
  exactly the `endedEarly()` error, which the app turns into `StaleFileError`;
  the reader is never asked for bytes past `size`;
- background behaviour: with a `yieldNow` that resolves immediately (as
  `yieldToUI` does outside the foreground), the hash completes before any
  macrotask runs, so it never waits on a timer;
- **> 4 GiB:** a real 4 GiB + 1 MiB + 13 B file (4 296 015 885 bytes)
  streamed through the shipped loop, past js-sha256's 32-bit byte counter
  carry (`hBytes`) and 2 GiB offsets: matches node:crypto
  (`31c9c5ad…fc80f9`, 75 s).

The app code is not changed elsewhere: `FileHandle` 64-bit offsets,
`StaleFileError`, `yieldToUI` and the `:v2` cache key in
`cachedSha256OfFile` work exactly as before.

## Native hashing: recommended follow-up (not shipped)

Native hashing is the only change that removes the big-file hash from the JS
thread, and the size of the gain is large. At ~1 GB/s native SHA-256 the
hash becomes I/O-bound. A 1 GB video drops from minutes of JS-thread time to
a few seconds on a background thread. It was not shipped because native code
can't be compiled or tested here, and a master push auto-builds the release
APK. Options, ranked:

1. **A small local Expo module** (`modules/file-sha256`, autolinked by
   `expo prebuild`). It would expose one `AsyncFunction("sha256", uri, size)`,
   which runs off the JS thread.
   - **Android:** `MessageDigest("SHA-256")` over `contentResolver.openInputStream`
     for `content://` URIs and a `FileInputStream` for decoded `file://` paths,
     with a 1 MiB reused buffer. It stops at `size` and throws when EOF comes
     early; JS maps that to `StaleFileError`.
   - **iOS:** CryptoKit `SHA256` or `CC_SHA256_Update` over `FileHandle`
     reads inside an `autoreleasepool`.
   - **JS:** `requireOptionalNativeModule` falls back to `sha256OfReader`
     when the module is missing.
   - **Pros:** exact control of size and early end, and no third-party
     native code.
   - **Cons:** about 100 lines of Kotlin and Swift to review.
   - **Risk:** low–medium. It uses the Expo Modules API that every expo-*
     package already compiles with.
2. **react-native-blob-util 0.25.1 `fs.hash(path, 'sha256')`.**
   - **What it does:** streams 1 MiB at a time on a background thread pool
     (Android) or a serial queue (iOS, with an autoreleasepool), and Android
     accepts `content://`.
   - **Catches:** iOS takes a plain path (`fileExistsAtPath`), so `file://`
     must be stripped and the path percent-decoded. Android strips
     `file://` but doesn't decode `%xx`. It hashes the whole file with no
     expected size, so stat before and after to keep the `StaleFileError`
     behaviour.
   - **Size and support:** it is a large library (networking and fetch
     polyfill) with its own config plugin, and RN 0.86 support is
     unverified.
3. **react-native-quick-crypto 1.1.9.** It requires
   react-native-nitro-modules ≥ 0.31.2, react-native-quick-base64 and a
   bundled OpenSSL. `createHash('sha256').update()` is native but runs
   **synchronously on the JS thread**, and the bytes still come through
   `readBytes`. The JS thread then spends about 1–2 ms per MiB instead of
   ~400 ms: a big improvement, but not off-thread, and it brings the
   heaviest native dependency chain.
4. Rejected:
   - @dr.pogodin/react-native-fs `hash()`: `File(filepath)` only, so no
     `content://` and no `file://` URIs.
   - expo-crypto (57 and 58): one-shot digest only.
   - expo-file-system: MD5 only.

For any native option, first build an APK with `workflow_dispatch` on a
branch (that doesn't publish a release; see README). Then check on a device
that a >4 GiB video's hash matches the server and that a camera-roll
`content://` / Photos original can be read.

## Caveats

- No Hermes VM: `--jitless` is a stand-in, and the phone estimates above
  are reasoned, not measured. The time-based budget keeps the *block*
  bound valid on any speed of device; only throughput is an estimate.
- The synthetic reader models the per-read allocation and copy, but not
  the native `readBytes` disk read or the JSI conversion cost on Android.
  Those are synchronous too, and smaller reads (1 MiB vs 16 MiB) shorten
  them in the same proportion.
- Making the JS thread responsive between slices fixes the freezes and
  starved touch handling. Hashing still uses most of the JS thread's time
  while a big file hashes; only native hashing removes that.
- Android raises a true ANR when the *main* thread is blocked. A frozen JS
  thread certainly makes the app unresponsive, but whether the main thread
  waited on it (a synchronous call into JS) in the user's report can't be
  confirmed from here.
- A pre-existing quirk outside this file: Android's
  `FileSystemFileHandle.read` returns a zero-padded buffer if the channel
  hits EOF before the size it computed (only when a file shrinks mid-read).

## Rerun

```bash
cd instacheese
(cd bench/hash && npm ci)                    # comparison-only libraries (optional)
node bench/hash/equivalence.mjs              # 1999 checks incl. > 4 GiB (~2 min)
node bench/hash/equivalence.mjs --skip-big   # ~30 s
node bench/hash/run.mjs --phase before       # pre-fix loop     (~3 min)
node bench/hash/run.mjs --phase after        # shipped loop × libraries (~15 min)
node bench/hash/run.mjs --phase libs         # raw throughput   (~8 min)
node bench/hash/run.mjs --phase sweep        # slicing trade-off (~4 min)
node bench/hash/run.mjs --quick              # smoke test (~40 s)
```

Raw results: `results/*.json`, `results/full-run.log`, `results/equivalence.txt`.
