// TEMPORARY benchmark screen (SDK 58 native digest). Not shipped: removed
// again right after the bench build. Open with
//   adb shell am start -a android.intent.action.VIEW -d 'instacheese://digest-bench'
// Optional query: ?sizes=128,1024&runs=3&only=env,check,digest,app,stale,fallback
// Every result is a logcat line (tag ReactNativeJS) starting "DIGESTBENCH ".
import * as Crypto from 'expo-crypto';
import { File, FileMode, Paths } from 'expo-file-system';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, Text } from 'react-native';

import { sha256OfReader } from '@/lib/hash-file';
import { StaleFileError, sha256OfFile, yieldToUI } from '@/lib/upload-protocol';

const MiB = 1024 * 1024;
const perf = (globalThis as { performance?: { now(): number } }).performance;
const now = perf ? () => perf.now() : () => Date.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// node:crypto over the same xorshift pattern files (bench/hash/common.mjs).
const EXPECTED: Record<number, string> = {
  1: 'b13261ceffb27a120f88c3466a3917bfb2875493d5f802422b433a3599407be6',
  128: '6d3dd32801dd029dc7bd16f8023e6c5ab3fe9794ba5814c5c8d20457bc9d1c12',
  1024: 'fac47e907b81053a0fc5cc103115ffc0c850c52f9e674f1e6bec9cedb2985216',
};
const ABC_HEX = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

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
const hex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0;
};
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};
const r1 = (x: number) => Math.round(x * 10) / 10;

// JS-thread responsiveness: a chained setTimeout(0) records the gap between
// consecutive ticks. A blocked JS thread shows up as a long gap.
function startTicker() {
  const gaps: number[] = [];
  let last = now();
  let running = true;
  const tick = () => {
    if (!running) return;
    const t = now();
    gaps.push(t - last);
    last = t;
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  return () => {
    running = false;
    return {
      ticks: gaps.length,
      maxGapMs: r1(Math.max(0, ...gaps)),
      p95GapMs: r1(pct(gaps, 95)),
      p99GapMs: r1(pct(gaps, 99)),
      medianGapMs: r1(median(gaps)),
    };
  };
}

async function makeFile(mib: number): Promise<File> {
  const file = new File(Paths.cache, `digest-bench-${mib}.bin`);
  if (file.exists && file.size === mib * MiB) return file;
  if (file.exists) file.delete();
  file.create();
  const w = file.open(FileMode.ReadWrite);
  try {
    for (let i = 0; i < mib; i++) w.writeBytesSync(patterned(MiB, i * MiB));
  } finally {
    w.close();
  }
  return file;
}

export default function DigestBench() {
  const params = useLocalSearchParams<{ sizes?: string; runs?: string; only?: string }>();
  const [lines, setLines] = useState<string[]>(['digest-bench starting…']);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const sizes = (params.sizes ?? '128,1024').split(',').map(Number);
    const runs = Number(params.runs ?? 3);
    const only = new Set((params.only ?? 'env,check,digest,app,stale,fallback').split(','));
    const out = (text: string, record?: object) => {
      setLines((ls) => [...ls, text]);
      console.log(`DIGESTBENCH ${JSON.stringify(record ?? { text })}`);
    };

    void (async () => {
      try {
        await sleep(500);
        if (only.has('env')) {
          const hermes = (
            globalThis as { HermesInternal?: { getRuntimeProperties?: () => object } }
          ).HermesInternal?.getRuntimeProperties?.();
          out(`env`, {
            kind: 'env',
            hermes: hermes ?? null,
            dev: __DEV__,
            platform: Platform.OS,
            constants: Platform.constants,
            sizes,
            runs,
          });
        }

        if (only.has('check')) {
          const abc = new File(Paths.cache, 'digest-bench-abc.txt');
          if (abc.exists) abc.delete();
          abc.create();
          await abc.write('abc');
          const one = await makeFile(1);
          const oneBytes = await one.bytes();
          const res = {
            kind: 'check',
            digestType: typeof one.digest,
            abc: (await abc.digest('SHA-256')) === ABC_HEX,
            oneMiB: (await one.digest('SHA-256')) === EXPECTED[1],
            matchesExpoCrypto:
              (await one.digest('SHA-256')) ===
              hex(new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, oneBytes))),
          };
          out(`check ${JSON.stringify(res)}`, res);
        }

        // Idle baseline for the ticker.
        {
          const stop = startTicker();
          await sleep(3000);
          const idle = { kind: 'idle', ...stop() };
          out(`idle ticker ${JSON.stringify(idle)}`, idle);
        }

        for (const mib of sizes) {
          const t0 = now();
          const file = await makeFile(mib);
          out(`file ${mib} MiB ready in ${r1(now() - t0)} ms`);
          const size = mib * MiB;
          for (const [kind, fn] of [
            ['digest', () => file.digest('SHA-256')],
            ['app', () => sha256OfFile(file.uri, size)],
          ] as const) {
            if (!only.has(kind)) continue;
            for (let i = 0; i < runs; i++) {
              const stop = startTicker();
              const t = now();
              const digest = await fn();
              const ms = now() - t;
              const ticker = stop();
              const res = {
                kind,
                fileMiB: mib,
                run: i,
                ms: r1(ms),
                mbps: r1(size / 1e6 / (ms / 1000)),
                correct: digest === EXPECTED[mib],
                ticker,
              };
              out(
                `${kind} ${mib} MiB: ${res.mbps} MB/s (${res.ms} ms) correct=${res.correct} maxGap=${ticker.maxGapMs} ms p95=${ticker.p95GapMs} ticks=${ticker.ticks}`,
                res
              );
              await sleep(300);
            }
          }
        }

        if (only.has('stale')) {
          const mib = sizes[0];
          const file = await makeFile(mib);
          const size = mib * MiB;
          const outcome = async (fn: () => Promise<string>) => {
            try {
              return `ok ${await fn()}`;
            } catch (err) {
              return `${err instanceof StaleFileError ? 'StaleFileError' : 'Error'}: ${String(err)}`;
            }
          };
          const res = {
            kind: 'stale',
            shorterThanRecorded: await outcome(() => sha256OfFile(file.uri, size + 1)),
            longerThanRecorded: await outcome(() => sha256OfFile(file.uri, size - 1)),
            missing: await outcome(() =>
              sha256OfFile(new File(Paths.cache, 'digest-bench-missing.bin').uri, 10)
            ),
          };
          out(`stale ${JSON.stringify(res)}`, res);
        }

        if (only.has('fallback')) {
          // The JS fallback (js-sha256, async readBytes) once over the first size.
          const mib = sizes[0];
          const file = await makeFile(mib);
          const size = mib * MiB;
          const stop = startTicker();
          const h = file.open(FileMode.ReadOnly);
          const t = now();
          let digest = '';
          try {
            digest = await sha256OfReader((n) => h.readBytes(n), size, yieldToUI, () => new Error('ended early'));
          } finally {
            h.close();
          }
          const ms = now() - t;
          const res = {
            kind: 'fallback',
            fileMiB: mib,
            ms: r1(ms),
            mbps: r1(size / 1e6 / (ms / 1000)),
            correct: digest === EXPECTED[mib],
            ticker: stop(),
          };
          out(`fallback ${JSON.stringify(res)}`, res);
        }
        out('DONE', { kind: 'done' });
      } catch (err) {
        out(`ERROR ${String(err)} ${(err as Error)?.stack ?? ''}`, { kind: 'error', error: String(err) });
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
