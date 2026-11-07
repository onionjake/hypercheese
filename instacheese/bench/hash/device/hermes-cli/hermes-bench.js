// Hermes CLI version of the device benchmark (see ../README.md). Bundled by
// bundle.mjs, which defines BENCH_CONFIG with the expected digests.
/* global BENCH_CONFIG, print, HermesInternal */
var MiB = 1024 * 1024;
var cfg = BENCH_CONFIG;
var now = typeof performance !== 'undefined' ? function () { return performance.now(); } : function () { return Date.now(); };
var out = typeof print === 'function' ? print : console.log;

var noble = require('@noble/hashes/sha2.js');
var nobleUtils = require('@noble/hashes/utils.js');
var jsSha256 = require('js-sha256').sha256;
var Stablelib = require('@stablelib/sha256').SHA256;
var Fast = require('fast-sha256').Hash;
var Asm = require('asmcrypto.js/dist_es5/hash/sha256/sha256').Sha256;
var shipped = require('../../../../src/lib/hash-file.ts');

function hex(u8) {
  var s = '';
  for (var i = 0; i < u8.length; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
  return s;
}
var LIBS = {
  '@noble/hashes': function () { var h = noble.sha256.create(); return { update: function (d) { h.update(d); }, hex: function () { return nobleUtils.bytesToHex(h.digest()); } }; },
  'js-sha256': function () { return jsSha256.create(); },
  '@stablelib/sha256': function () { var h = new Stablelib(); return { update: function (d) { h.update(d); }, hex: function () { return hex(h.digest()); } }; },
  'fast-sha256': function () { var h = new Fast(); return { update: function (d) { h.update(d); }, hex: function () { return hex(h.digest()); } }; },
  'asmcrypto.js': function () { var h = new Asm(); return { update: function (d) { h.process(d); }, hex: function () { return hex(h.finish().result); } }; },
};

// Same synthetic content as bench/hash/common.mjs (xorshift pattern).
function xorshiftBytes(n, seed) {
  var o = new Uint8Array(n), x = seed >>> 0 || 1;
  for (var i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; o[i] = x & 0xff; }
  return o;
}
var PATTERN = xorshiftBytes(MiB + 7, 0x9e3779b9);
function fillFrom(t, off) {
  var pos = 0, p = off % PATTERN.length;
  while (pos < t.length) { var n = Math.min(PATTERN.length - p, t.length - pos); t.set(PATTERN.subarray(p, p + n), pos); pos += n; p = 0; }
}
function median(xs) { var s = xs.slice().sort(function (a, b) { return a - b; }); var m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function pct(xs, p) { var s = xs.slice().sort(function (a, b) { return a - b; }); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; }
function r2(x) { return Math.round(x * 100) / 100; }
function emit(o) { out('HASHBENCH ' + JSON.stringify(o)); }

emit({ kind: 'env', hermes: typeof HermesInternal !== 'undefined' && HermesInternal.getRuntimeProperties ? HermesInternal.getRuntimeProperties() : null, cfg: { memMiB: cfg.memMiB, fileMiB: cfg.fileMiB, runs: cfg.runs, fileRuns: cfg.fileRuns } });

async function main() {
  var data = new Uint8Array(cfg.memMiB * MiB);
  fillFrom(data, 0);
  var step = 32 * 1024;
  var names = Object.keys(LIBS);
  for (var li = 0; li < names.length; li++) {
    var name = names[li], make = LIBS[name];
    var w = make(); for (var p = 0; p < MiB; p += step) w.update(data.subarray(p, p + step)); w.hex();
    var ms = [], digest = '';
    for (var i = 0; i < cfg.runs; i++) {
      var t = now(), h = make();
      for (var q = 0; q < data.length; q += step) h.update(data.subarray(q, q + step));
      digest = h.hex();
      ms.push(now() - t);
    }
    emit({ kind: 'libs', lib: name, sizeMiB: cfg.memMiB, ms: ms.map(r2), medianMbps: r2(data.length / 1e6 / (median(ms) / 1000)), correct: digest === cfg.memHex });
  }
  // Shipped loop over a synthetic file (fresh buffer + copy per read, as
  // expo-file-system's readBytes); microtask yields, block = time between.
  var size = cfg.fileMiB * MiB;
  var reader = ['@noble/hashes', 'js-sha256'];
  for (var ri = 0; ri < reader.length; ri++) {
    var rname = reader[ri], per = [], d = '';
    for (var k = 0; k < cfg.fileRuns; k++) {
      var offset = 0, blocks = [], t0 = now(), resume = t0;
      d = await shipped.sha256OfReader(
        function (len) { var n = Math.max(0, Math.min(len, size - offset)); var b = new Uint8Array(n); fillFrom(b, offset); offset += n; return b; },
        size,
        function () { blocks.push(now() - resume); return Promise.resolve().then(function () { resume = now(); }); },
        function () { return new Error('ended early'); },
        { createHash: LIBS[rname], now: now }
      );
      blocks.push(now() - resume);
      per.push({ ms: now() - t0, maxBlock: Math.max.apply(null, blocks), p95: pct(blocks, 95), blocks: blocks.length });
    }
    emit({ kind: 'reader', lib: rname, fileMiB: cfg.fileMiB, mbps: r2(size / 1e6 / (median(per.map(function (x) { return x.ms; })) / 1000)), medianMaxBlockMs: r2(median(per.map(function (x) { return x.maxBlock; }))), medianP95BlockMs: r2(median(per.map(function (x) { return x.p95; }))), blocks: per[0].blocks, correct: d === cfg.fileHex });
  }
  emit({ kind: 'done' });
}
main().catch(function (e) { emit({ kind: 'error', error: String(e), stack: e && e.stack }); });
