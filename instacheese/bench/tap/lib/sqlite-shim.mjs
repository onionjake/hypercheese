// A stand-in for the slice of expo-sqlite's async API that library-db.ts
// uses, backed by node's built-in node:sqlite (same SQLite engine family:
// node 22 bundles 3.5x, expo-sqlite 57 vendors 3.50.3).
//
// Not modelled: the JSI/native-thread hop each expo-sqlite call makes
// (prepare/execute/finalize on Dispatchers.IO). Timings here are SQLite
// engine time on this machine, not device time.
import { DatabaseSync } from 'node:sqlite';

export function createSqliteShim() {
  const shim = {
    nextPath: ':memory:',
    // Every statement the module runs: { sql, params, ms }.
    capture: null,
    raw: null, // the DatabaseSync of the last opened database
    openDatabaseAsync: async () => {
      const db = new DatabaseSync(shim.nextPath);
      // expo-sqlite builds with SQLITE_TEMP_STORE=2 (temp tables/sorts in RAM).
      db.exec('PRAGMA temp_store = MEMORY');
      shim.raw = db;
      return wrap(db, shim);
    },
  };
  return shim;
}

function flat(params) {
  // expo-sqlite accepts both spread args and a single array/object.
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params;
}

function timed(shim, sql, params, fn) {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    if (shim.capture) shim.capture.push({ sql, params, ms: performance.now() - t0 });
  }
}

function wrap(db, shim) {
  const api = {
    async execAsync(sql) {
      timed(shim, sql, [], () => db.exec(sql));
    },
    async getAllAsync(sql, ...params) {
      const p = flat(params);
      return timed(shim, sql, p, () => db.prepare(sql).all(...p));
    },
    async getFirstAsync(sql, ...params) {
      const p = flat(params);
      return timed(shim, sql, p, () => db.prepare(sql).get(...p) ?? null);
    },
    async runAsync(sql, ...params) {
      const p = flat(params);
      return timed(shim, sql, p, () => {
        const r = db.prepare(sql).run(...p);
        return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
      });
    },
    // Same (non-exclusive) semantics as expo-sqlite's withTransactionAsync.
    async withTransactionAsync(task) {
      try {
        await api.execAsync('BEGIN');
        await task();
        await api.execAsync('COMMIT');
      } catch (e) {
        await api.execAsync('ROLLBACK');
        throw e;
      }
    },
  };
  return api;
}
