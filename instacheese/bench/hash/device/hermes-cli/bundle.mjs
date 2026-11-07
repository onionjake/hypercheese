// Bundles hermes-bench.js + the hash libraries + the shipped
// src/lib/hash-file.ts into one script for the Hermes CLI (no module
// system there). A tiny CommonJS bundler: ESM/TS files are transpiled to
// CommonJS with the app's TypeScript, require() calls are rewritten to
// bundle-local ids. Libraries come from instacheese/node_modules (bench
// build) or bench/hash/node_modules (npm ci there).
//
//   node bench/hash/device/hermes-cli/bundle.mjs > /tmp/hb.js
//   hermesc -O -emit-binary -out /tmp/hb.hbc /tmp/hb.js && hermes /tmp/hb.hbc
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MiB, PATTERN, referenceHex } from '../../common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..', '..', '..');
const BENCH = join(HERE, '..', '..');
const ts = createRequire(join(APP, 'package.json'))('typescript');

const modules = new Map(); // absolute path -> { id, code }
const EMPTY = '<empty>';

function resolve(spec, from) {
  if (spec === 'crypto' || spec === 'buffer') return EMPTY; // js-sha256's Node-only branch
  // Bare specifiers: the app's copy first (what Metro bundles).
  const bases = spec.startsWith('.') ? [dirname(from)] : [APP, dirname(from), BENCH];
  for (const base of bases) {
    try {
      return createRequire(join(base, 'x.js')).resolve(spec);
    } catch {}
    // ESM-only extensionless relative imports (asmcrypto dist_es5).
    if (spec.startsWith('.')) {
      for (const ext of ['.js', '.ts', '/index.js']) {
        const p = join(dirname(from), spec + ext);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error(`cannot resolve ${spec} from ${from}`);
}

function add(path) {
  if (modules.has(path)) return modules.get(path).id;
  const entry = { id: modules.size, code: '' };
  modules.set(path, entry);
  if (path === EMPTY) return entry.id;
  let src = readFileSync(path, 'utf8');
  if (path.endsWith('.ts') || /^\s*(import|export)\b/m.test(src)) {
    src = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
      fileName: path,
    }).outputText;
  }
  entry.code = src.replace(/\brequire\((['"])([^'"]+)\1\)/g, (_, _q, spec) => `__req(${add(resolve(spec, path))})`);
  return entry.id;
}

const config = {
  memMiB: Number(process.env.MEM_MIB ?? 16),
  fileMiB: Number(process.env.FILE_MIB ?? 64),
  runs: Number(process.env.RUNS ?? 5),
  fileRuns: Number(process.env.FILE_RUNS ?? 3),
};
const entryId = add(join(HERE, 'hermes-bench.js'));
const parts = [
  // Hide Node's process so js-sha256 takes its non-Node path (as on Hermes).
  `var process = undefined;`,
  `var __mods = [], __cache = [];`,
  `function __req(id) { if (__cache[id]) return __cache[id].exports; var m = __cache[id] = { exports: {} }; if (__mods[id]) __mods[id].call(m.exports, m, m.exports, __req); return m.exports; }`,
];
for (const [path, { id, code }] of modules) {
  parts.push(`// ${path.replace(APP, 'instacheese')}`);
  parts.push(`__mods[${id}] = function (module, exports, require) {\n${code}\n};`);
}
parts.push(`var BENCH_CONFIG = ${JSON.stringify({
  ...config,
  memHex: referenceHex(config.memMiB * MiB),
  fileHex: referenceHex(config.fileMiB * MiB),
  patternLength: PATTERN.length,
})};`);
parts.push(`__req(${entryId});`);
process.stdout.write(parts.join('\n') + '\n');
