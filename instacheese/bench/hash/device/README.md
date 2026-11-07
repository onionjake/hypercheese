# On-device (Hermes) SHA-256 benchmark

Real Hermes numbers for the large-file hash, measured in a release APK on
an Android device. Results: `../RESULTS.md` ("Android emulator, Hermes").

The app does **not** ship this screen. To rerun it, make a throwaway bench
build on a branch (never `master`: a master push publishes a release):

1. Copy `hash-bench.tsx` to `src/app/hash-bench.tsx` (drop its first
   `// @ts-nocheck` line).
2. In `src/app/_layout.tsx`, skip the sign-in redirect for this route, at
   the top of the redirect effect (after the `loading` check):

   ```ts
   if ((segments[0] as string) === 'hash-bench') return;
   ```

3. Add the bench-only libraries to the app (for this build only):

   ```bash
   npm install --save-exact @stablelib/sha256@2.0.1 fast-sha256@1.3.0 asmcrypto.js@2.3.2
   ```

   (`js-sha256`, `@noble/hashes`, `expo-crypto` and `expo-file-system` are
   already app dependencies.) Then `npx tsc --noEmit`.
4. Commit to the branch and run the "Build InstaCheese APK" workflow
   (`workflow_dispatch`) on it. Branch runs upload `instacheese-apk` as a
   run artifact and publish nothing. The APK is a normal release build
   (`assembleRelease`, Hermes bytecode compiled with `hermesc -O`, all ABIs).
5. Install the APK on a device or emulator and open
   `instacheese://hash-bench`:

   ```bash
   adb shell am start -a android.intent.action.VIEW -d 'instacheese://hash-bench'
   # optional query: ?mem=16&file=128&runs=5&fileRuns=3&only=env,check,native,read,reader,libs
   adb logcat -d -s ReactNativeJS | grep HASHBENCH
   ```

   Keep the app in the foreground (`settings put global
   stay_on_while_plugged_in 7` keeps the screen on). A full run takes a
   few minutes; it ends with a `DONE` line. Every result is one
   `HASHBENCH {json}` logcat line and is also shown on screen.

What it measures:

- `env`: Hermes runtime properties, `__DEV__`, device ABIs and model.
- `check`: each library against the `abc` and 448-bit NIST vectors and
  against expo-crypto's native digest on 1 MiB + 7 bytes, fed in odd
  (4099-byte) slices.
- `native`: `Crypto.digest` (expo-crypto, one shot, synchronous on
  Android) on 16 and 64 MiB.
- `read`: `FileHandle.readBytes` alone over the generated file (1 MiB and
  16 MiB reads).
- `reader`: the shipped `sha256OfReader` (1 MiB reads, 16 KiB slices,
  20 ms budget, `setTimeout(0)` yields like the app's foreground
  `yieldToUI`) on a real file in the cache directory, per library. "Block"
  is the time between yields: the longest uninterrupted JS-thread stretch.
- `libs`: in-memory throughput, 32 KiB updates, median of 5 runs.

## Hermes CLI (`hermes-cli/`)

The same pure-JS cases, run by a desktop `hermes` built from the Hermes
tag React Native 0.86 uses (`hermes-v250829098.0.14`, Hermes V1; see
`node_modules/react-native/sdks/hermes-engine/version.properties`).

```bash
# Build Hermes (Linux; ~25 min on 4 cores)
git clone --depth 1 --branch hermes-v250829098.0.14 https://github.com/facebook/hermes.git
cmake -S hermes -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
ninja -C build hermes hermesc

# Bundle and run (bench/hash/node_modules from `npm ci` there, or the
# bench libraries in the app's node_modules)
MEM_MIB=16 FILE_MIB=128 node bench/hash/device/hermes-cli/bundle.mjs > hb.js
build/bin/hermesc -O -emit-binary -out hb.hbc hb.js
build/bin/hermes hb.hbc
```
