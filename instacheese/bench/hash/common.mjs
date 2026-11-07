// Shared helpers for the hashing benchmarks and equivalence test.
// Plain .mjs (not .ts) so `npx tsc --noEmit` ignores it and it also runs
// under `node --jitless` (Node's TypeScript stripping needs WebAssembly,
// which --jitless disables).
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const APP = join(HERE, '..', '..');
const require = createRequire(join(APP, 'package.json'));

export const MiB = 1024 * 1024;

// --- The shipped loop: transpile src/lib/hash-file.ts once ------------------
// Output goes to bench/hash/.build/ (git-ignored) so its js-sha256 import
// resolves from instacheese/node_modules, like the app's.
export function buildShipped() {
  const ts = require('typescript');
  const src = readFileSync(join(APP, 'src/lib/hash-file.ts'), 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dir = join(HERE, '.build');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hash-file.mjs'), out);
}

export async function loadShipped() {
  return import(join(HERE, '.build', 'hash-file.mjs'));
}

// --- Synthetic file -----------------------------------------------------------
// Deterministic content: byte i = PATTERN[i % PATTERN.length], with a
// pattern length that is not a multiple of 64 so blocks differ. Nothing
// touches the disk; any size (even > 4 GiB) costs ~1 MiB of memory.
function xorshiftBytes(n, seed) {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}
export const PATTERN = xorshiftBytes(MiB + 7, 0x9e3779b9);

export function fillFrom(target, offset) {
  // Copy file bytes [offset, offset + target.length) into target.
  let pos = 0;
  let p = offset % PATTERN.length;
  while (pos < target.length) {
    const n = Math.min(PATTERN.length - p, target.length - pos);
    target.set(PATTERN.subarray(p, p + n), pos);
    pos += n;
    p = 0;
  }
}

// Models expo-file-system's FileHandle.readBytes: a fresh buffer per call,
// filled by a copy (the JSI conversion of the native ByteArray). The native
// disk read on the phone is NOT modelled — see RESULTS.md caveats.
export class SyntheticFile {
  constructor(size) {
    this.size = size;
    this.offset = 0;
    this.allocations = 0;
    this.maxAllocation = 0;
  }
  readBytes(length) {
    const n = Math.max(0, Math.min(length, this.size - this.offset));
    const buf = new Uint8Array(n);
    fillFrom(buf, this.offset);
    this.offset += n;
    this.allocations++;
    if (n > this.maxAllocation) this.maxAllocation = n;
    return buf;
  }
}

export function referenceHex(size) {
  const h = createHash('sha256');
  const piece = new Uint8Array(16 * MiB);
  for (let off = 0; off < size; off += piece.length) {
    const n = Math.min(piece.length, size - off);
    const view = piece.subarray(0, n);
    fillFrom(view, off);
    h.update(view);
  }
  return h.digest('hex');
}

// --- Hash libraries behind one interface: update(Uint8Array) / hex() ---------
// (the interface src/lib/hash-file.ts takes). Adapters below return
// { update, digest } and are wrapped to add hex().
export async function hashers() {
  const { sha256: jsSha256 } = require('js-sha256');
  const forge = require('node-forge');
  const toBinaryString = (u8) => {
    // forge only takes "binary strings"; on the phone this conversion is
    // part of its cost, so it is measured too.
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    }
    return s;
  };
  const adapters = {
    // Exactly what the app uses (it has hex() itself).
    'js-sha256': () => jsSha256.create(),
    'node-forge': () => {
      const md = forge.md.sha256.create();
      return {
        update: (d) => md.update(toBinaryString(d)),
        digest: () => Uint8Array.from(md.digest().getBytes(), (c) => c.charCodeAt(0)),
      };
    },
    // Comparison-only libraries from bench/hash/node_modules (npm ci there).
    ...(await benchOnlyHashers()),
    // Native (OpenSSL). Stands in for any native hasher; not usable on the
    // phone as-is.
    'node:crypto': () => {
      const h = createHash('sha256');
      return { update: (d) => h.update(d), digest: () => new Uint8Array(h.digest()) };
    },
  };
  const out = {};
  for (const [name, make] of Object.entries(adapters)) {
    out[name] = () => {
      const h = make();
      return h.hex ? h : { update: (d) => h.update(d), hex: () => toHex(h.digest()) };
    };
  }
  return out;
}

async function benchOnlyHashers() {
  const benchRequire = createRequire(join(HERE, 'package.json'));
  const out = {};
  const tryAdd = async (name, load) => {
    try {
      out[name] = await load();
    } catch (err) {
      process.stderr.write(`(skipping ${name}: ${err.code ?? err.message}; run npm ci in bench/hash)\n`);
    }
  };
  await tryAdd('@noble/hashes', async () => {
    const { sha256 } = await import(benchRequire.resolve('@noble/hashes/sha2.js'));
    return () => sha256.create();
  });
  await tryAdd('@stablelib/sha256', async () => {
    const { SHA256 } = await import(benchRequire.resolve('@stablelib/sha256'));
    return () => new SHA256();
  });
  await tryAdd('fast-sha256', async () => {
    const { Hash } = benchRequire('fast-sha256');
    return () => new Hash();
  });
  await tryAdd('@aws-crypto/sha256-js', async () => {
    const { Sha256 } = benchRequire('@aws-crypto/sha256-js');
    return () => {
      const h = new Sha256();
      return { update: (d) => h.update(d), digest: () => h.digestSync() };
    };
  });
  await tryAdd('jssha', async () => {
    const jsSHA = benchRequire('jssha');
    return () => {
      const h = new jsSHA('SHA-256', 'UINT8ARRAY');
      return { update: (d) => h.update(d), digest: () => h.getHash('UINT8ARRAY') };
    };
  });
  await tryAdd('hash.js', async () => {
    const hashjs = benchRequire('hash.js');
    return () => {
      const h = hashjs.sha256();
      return { update: (d) => h.update(d), digest: () => Uint8Array.from(h.digest()) };
    };
  });
  await tryAdd('crypto-js', async () => {
    const CryptoJS = benchRequire('crypto-js');
    return () => {
      const h = CryptoJS.algo.SHA256.create();
      return {
        // WordArray conversion is part of its cost on the phone too.
        update: (d) => h.update(CryptoJS.lib.WordArray.create(d)),
        digest: () => Uint8Array.from(Buffer.from(h.finalize().toString(CryptoJS.enc.Hex), 'hex')),
      };
    };
  });
  await tryAdd('asmcrypto.js', async () => {
    const { Sha256 } = benchRequire('asmcrypto.js');
    return () => {
      const h = new Sha256();
      return { update: (d) => h.process(d), digest: () => h.finish().result };
    };
  });
  return out;
}

export const toHex = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('hex');

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
