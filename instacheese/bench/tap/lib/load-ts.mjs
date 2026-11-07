// Loads one of the app's TypeScript modules (src/lib/*.ts) into node with its
// imports replaced by mocks, so the benchmark runs the app's REAL code (SQL
// strings, migrations, serialization logic) rather than a re-typed copy.
//
//   impl = 'current'  -> the file in the working tree
//   impl = 'baseline' -> the file as of BASELINE_SHA (the code before the fix)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// The commit the "before" numbers were taken against (unmodified
// mark-reminder.ts / library-db.ts / settings.ts).
export const BASELINE_SHA = 'a1122398372f0661ec4fd219482a78d3fb7172c0';

export function readSource(relPath, impl) {
  if (impl === 'baseline') {
    return execFileSync('git', ['show', `${BASELINE_SHA}:instacheese/${relPath}`], {
      cwd: APP_DIR,
      encoding: 'utf8',
    });
  }
  if (impl === 'current') return readFileSync(path.join(APP_DIR, relPath), 'utf8');
  throw new Error(`unknown impl ${impl} (expected baseline|current)`);
}

// mocks: { 'module-specifier': exportsObject }. Every import must be mocked.
export function loadTs(relPath, impl, mocks) {
  const source = readSource(relPath, impl);
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: relPath,
  });
  const module = { exports: {} };
  const req = (spec) => {
    if (Object.prototype.hasOwnProperty.call(mocks, spec)) return mocks[spec];
    throw new Error(`${relPath}: import '${spec}' is not mocked`);
  };
  new Function('exports', 'require', 'module', outputText)(module.exports, req, module);
  return module.exports;
}

export function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
