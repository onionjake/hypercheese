// @ts-nocheck -- bench-only copy; its libraries are not app dependencies (see README.md).
// TEMPORARY benchmark screen (bench/hash/device/). Open with
//   adb shell am start -a android.intent.action.VIEW -d 'instacheese://hash-bench'
// Optional query: ?mem=16&file=128&runs=5&fileRuns=3&only=env,check,native,read,reader,libs
// Results render as text and are logged to logcat (tag ReactNativeJS) as
// lines starting with "HASHBENCH ".
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { SHA256 as StablelibSha256 } from '@stablelib/sha256';
// asmcrypto.all.js requires Node's crypto (for random); import just SHA-256.
import { Sha256 as AsmSha256 } from 'asmcrypto.js/dist_es5/hash/sha256/sha256';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { File, FileMode, Paths } from 'expo-file-system';
import { useLocalSearchParams } from 'expo-router';
import { Hash as FastSha256 } from 'fast-sha256';
import { sha256 as jsSha256 } from 'js-sha256';
import { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, Text } from 'react-native';

import { sha256OfReader, type IncrementalHash } from '@/lib/hash-file';
import { log } from '@/lib/log';

const MiB = 1024 * 1024;
const perf = (globalThis as { performance?: { now(): number } }).performance;
const now = perf ? () => perf.now() : () => Date.now();
const sleep0 = () => new Promise<void>((r) => setTimeout(r, 0));

function hex(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

// Every library behind the IncrementalHash interface sha256OfReader takes.
const LIBS: Record<string, () => IncrementalHash> = {
  '@noble/hashes': () => {
    const h = nobleSha256.create();
    return { update: (d) => h.update(d), hex: () => bytesToHex(h.digest()) };
  },
  'js-sha256': () => jsSha256.create(),
  '@stablelib/sha256': () => {
    const h = new StablelibSha256();
    return { update: (d) => h.update(d), hex: () => hex(h.digest()) };
  },
  'fast-sha256': () => {
    const h = new FastSha256();
    return { update: (d) => h.update(d), hex: () => hex(h.digest()) };
  },
  'asmcrypto.js': () => {
    const h = new AsmSha256();
    return { update: (d) => h.process(d), hex: () => hex(h.finish().result!) };
  },
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

// Test data: a 1 MiB + 7 byte xorshift pattern (as bench/hash/common.mjs),
// repeated. expo-crypto's getRandomBytes caps at 1024 bytes.
function xorshiftBytes(n: number, seed: number): Uint8Array<ArrayBuffer> {
  const o = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    o[i] = x & 0xff;
  }
  return o;
}
let pattern: Uint8Array<ArrayBuffer> | null = null;
function patterned(n: number, offset = 0): Uint8Array<ArrayBuffer> {
  pattern ??= xorshiftBytes(MiB + 7, 0x9e3779b9);
  const out = new Uint8Array(n);
  let pos = 0;
  let p = offset % pattern.length;
  while (pos < n) {
    const k = Math.min(pattern.length - p, n - pos);
    out.set(pattern.subarray(p, p + k), pos);
    pos += k;
    p = 0;
  }
  return out;
}

const ABC = new Uint8Array([0x61, 0x62, 0x63]) as Uint8Array<ArrayBuffer>;
const ABC_HEX = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const NIST2 = new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq');
const NIST2_HEX = '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1';

export default function HashBench() {
  const params = useLocalSearchParams<{
    mem?: string;
    file?: string;
    runs?: string;
    fileRuns?: string;
    only?: string;
  }>();
  const [lines, setLines] = useState<string[]>(['hash-bench starting…']);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const memMiB = Number(params.mem ?? 16);
    const fileMiB = Number(params.file ?? 128);
    const runs = Number(params.runs ?? 5);
    const fileRuns = Number(params.fileRuns ?? 3);
    const only = new Set((params.only ?? 'env,check,native,read,reader,libs').split(','));

    const out = (text: string, record?: object) => {
      setLines((ls) => [...ls, text]);
      const line = `HASHBENCH ${JSON.stringify(record ?? { text })}`;
      console.log(line);
      log('hash-bench', line);
    };

    void (async () => {
      try {
        await sleep0();
        // --- Environment ----------------------------------------------------
        const hermes = (
          globalThis as { HermesInternal?: { getRuntimeProperties?: () => object } }
        ).HermesInternal?.getRuntimeProperties?.();
        const env = {
          kind: 'env',
          hermes: hermes ?? null,
          dev: __DEV__,
          platform: Platform.OS,
          constants: Platform.constants,
          device: {
            brand: Device.brand,
            manufacturer: Device.manufacturer,
            modelName: Device.modelName,
            isDevice: Device.isDevice,
            osVersion: Device.osVersion,
            abis: Device.supportedCpuArchitectures,
            totalMemory: Device.totalMemory,
          },
          webassembly: typeof (globalThis as { WebAssembly?: unknown }).WebAssembly,
          params: { memMiB, fileMiB, runs, fileRuns, only: [...only] },
        };
        out(`env ${JSON.stringify(env)}`, env);

        // In-memory test data.
        const data = patterned(memMiB * MiB);
        const nativeHex = hex(
          new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data))
        );

        // --- Correctness ----------------------------------------------------
        if (only.has('check')) {
          for (const [name, make] of Object.entries(LIBS)) {
            const oneShot = (d: Uint8Array) => {
              const h = make();
              h.update(d);
              return h.hex();
            };
            const sliced = (d: Uint8Array, step: number) => {
              const h = make();
              for (let p = 0; p < d.length; p += step) h.update(d.subarray(p, p + step));
              return h.hex();
            };
            const res = {
              kind: 'check',
              lib: name,
              abc: oneShot(ABC) === ABC_HEX,
              nist448: oneShot(NIST2) === NIST2_HEX,
              // 1 MiB + odd slicing vs the native digest.
              native1MiBOdd:
                sliced(data.subarray(0, MiB + 7), 4099) ===
                hex(
                  new Uint8Array(
                    await Crypto.digest(
                      Crypto.CryptoDigestAlgorithm.SHA256,
                      data.slice(0, MiB + 7)
                    )
                  )
                ),
            };
            out(`check ${name}: ${JSON.stringify(res)}`, res);
            await sleep0();
          }
          const nativeAbc = hex(
            new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, ABC))
          );
          out(`check native abc: ${nativeAbc === ABC_HEX}`, {
            kind: 'check',
            lib: 'expo-crypto',
            abc: nativeAbc === ABC_HEX,
          });
        }

        // --- Native ceiling: expo-crypto one-shot digest ---------------------
        if (only.has('native')) {
          for (const sizeMiB of [16, 64]) {
            const buf = sizeMiB === memMiB ? data : patterned(sizeMiB * MiB);
            const ms: number[] = [];
            for (let i = 0; i < runs; i++) {
              const t = now();
              await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, buf);
              ms.push(now() - t);
              await sleep0();
            }
            const res = {
              kind: 'native',
              lib: 'expo-crypto Crypto.digest',
              sizeMiB,
              ms: ms.map(r1),
              medianMs: r1(median(ms)),
              mbps: r1((sizeMiB * MiB) / 1e6 / (median(ms) / 1000)),
            };
            out(`native ${sizeMiB} MiB: ${res.mbps} MB/s (median ${res.medianMs} ms)`, res);
          }
        }

        // --- Real file: create, then readBytes alone, then the shipped loop --
        const file = new File(Paths.cache, 'hash-bench.bin');
        const fileSize = fileMiB * MiB;
        if (only.has('read') || only.has('reader')) {
          if (!file.exists || file.size !== fileSize) {
            if (file.exists) file.delete();
            file.create();
            const t = now();
            const w = file.open(FileMode.ReadWrite);
            try {
              for (let i = 0; i < fileMiB; i++) w.writeBytes(patterned(MiB, i * MiB));
            } finally {
              w.close();
            }
            out(`wrote ${fileMiB} MiB file in ${r1(now() - t)} ms`);
          }
        }

        if (only.has('read')) {
          for (const readSize of [MiB, 16 * MiB]) {
            const ms: number[] = [];
            let maxRead = 0;
            for (let i = 0; i < 3; i++) {
              const h = file.open(FileMode.ReadOnly);
              const t = now();
              try {
                for (let read = 0; read < fileSize; ) {
                  const t1 = now();
                  const chunk = h.readBytes(Math.min(readSize, fileSize - read));
                  maxRead = Math.max(maxRead, now() - t1);
                  if (chunk.length === 0) throw new Error('short read');
                  read += chunk.length;
                }
              } finally {
                h.close();
              }
              ms.push(now() - t);
              await sleep0();
            }
            const res = {
              kind: 'read',
              readSizeMiB: readSize / MiB,
              fileMiB,
              ms: ms.map(r1),
              mbps: r1(fileSize / 1e6 / (median(ms) / 1000)),
              maxReadMs: r1(maxRead),
              medianReadMs: r1(median(ms) / (fileSize / readSize)),
            };
            out(
              `readBytes ${readSize / MiB} MiB: ${res.mbps} MB/s, per read median ${res.medianReadMs} ms, max ${res.maxReadMs} ms`,
              res
            );
          }
        }

        if (only.has('reader')) {
          const digests: Record<string, string> = {};
          for (const name of ['@noble/hashes', 'js-sha256']) {
            const per: {
              ms: number;
              maxBlock: number;
              p95Block: number;
              blocks: number;
              busyMs: number;
            }[] = [];
            for (let i = 0; i < fileRuns; i++) {
              const h = file.open(FileMode.ReadOnly);
              const blocks: number[] = [];
              const t0 = now();
              let resume = t0;
              try {
                // Same yield as the app's foreground yieldToUI: setTimeout(0).
                digests[name] = await sha256OfReader(
                  (length) => h.readBytes(length),
                  fileSize,
                  async () => {
                    blocks.push(now() - resume);
                    await sleep0();
                    resume = now();
                  },
                  () => new Error('ended early'),
                  { createHash: LIBS[name] }
                );
              } finally {
                h.close();
              }
              blocks.push(now() - resume);
              const total = now() - t0;
              per.push({
                ms: total,
                maxBlock: Math.max(...blocks),
                p95Block: pct(blocks, 95),
                blocks: blocks.length,
                busyMs: blocks.reduce((a, b) => a + b, 0),
              });
              await sleep0();
            }
            const res = {
              kind: 'reader',
              lib: name,
              fileMiB,
              runs: per.map((p) => ({
                ms: r1(p.ms),
                maxBlock: r1(p.maxBlock),
                p95Block: r1(p.p95Block),
                blocks: p.blocks,
              })),
              mbps: r2(fileSize / 1e6 / (median(per.map((p) => p.ms)) / 1000)),
              busyMbps: r2(fileSize / 1e6 / (median(per.map((p) => p.busyMs)) / 1000)),
              medianMaxBlockMs: r1(median(per.map((p) => p.maxBlock))),
              worstMaxBlockMs: r1(Math.max(...per.map((p) => p.maxBlock))),
              medianP95BlockMs: r1(median(per.map((p) => p.p95Block))),
              digest: digests[name],
            };
            out(
              `reader ${name} ${fileMiB} MiB: ${res.mbps} MB/s, longest block median ${res.medianMaxBlockMs} ms (worst ${res.worstMaxBlockMs}), p95 ${res.medianP95BlockMs} ms`,
              res
            );
          }
          out(
            `reader digests agree: ${digests['@noble/hashes'] === digests['js-sha256']}`,
            { kind: 'reader-agree', ok: digests['@noble/hashes'] === digests['js-sha256'] }
          );
        }

        // --- Pure-JS throughput, in memory, 32 KiB updates -----------------
        if (only.has('libs')) {
          const step = 32 * 1024;
          for (const [name, make] of Object.entries(LIBS)) {
            // Warm-up (1 MiB) so lazy init/tables aren't timed.
            {
              const h = make();
              for (let p = 0; p < MiB; p += step) h.update(data.subarray(p, p + step));
              h.hex();
            }
            const ms: number[] = [];
            let digest = '';
            for (let i = 0; i < runs; i++) {
              const t = now();
              const h = make();
              for (let p = 0; p < data.length; p += step) h.update(data.subarray(p, p + step));
              digest = h.hex();
              ms.push(now() - t);
              await sleep0();
            }
            const mbps = ms.map((m) => data.length / 1e6 / (m / 1000));
            const res = {
              kind: 'libs',
              lib: name,
              sizeMiB: memMiB,
              ms: ms.map(r1),
              mbps: mbps.map(r2),
              medianMbps: r2(median(mbps)),
              correct: digest === nativeHex,
            };
            out(
              `libs ${name}: ${res.medianMbps} MB/s (median of ${runs}, ${memMiB} MiB), correct=${res.correct}`,
              res
            );
          }
        }
        out('DONE', { kind: 'done' });
      } catch (err) {
        out(`ERROR ${String(err)} ${(err as Error)?.stack ?? ''}`, {
          kind: 'error',
          error: String(err),
        });
      }
    })();
  }, [params]);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 48 }}>
      {lines.map((l, i) => (
        <Text key={i} selectable style={{ fontFamily: 'monospace', fontSize: 11, marginBottom: 4 }}>
          {l}
        </Text>
      ))}
    </ScrollView>
  );
}
