'use strict';
// Stand-in for src/lib/upload-queue.ts: same subscribe API; the harness
// drives emitItem / broadcastSummary directly, mirroring how the real drain
// calls them (see upload-queue.ts emitItem / setItemStatus / settle).
const { hop } = require('./io');

const itemListeners = new Set();
const summaryListeners = new Set();
let summary = { state: 'running', reason: null, remaining: 400, failed: 0, finished: 0, current: null };

function getSummary() {
  return summary;
}
function subscribeSummary(fn) {
  summaryListeners.add(fn);
  fn(summary);
  return () => summaryListeners.delete(fn);
}
function subscribeItems(fn) {
  itemListeners.add(fn);
  return () => itemListeners.delete(fn);
}
function emitItem(item) {
  itemListeners.forEach((fn) => fn(item));
}
function broadcastSummary(next) {
  summary = next;
  summaryListeners.forEach((fn) => fn(summary));
}
const assetKey = (id) => `asset:${id}`;
async function removeQueued() {
  await hop();
}
async function enqueueBackupPending() {
  await hop();
}
function kick() {}
function stop() {}

module.exports = {
  __esModule: true,
  getSummary,
  subscribeSummary,
  subscribeItems,
  emitItem,
  broadcastSummary,
  assetKey,
  removeQueued,
  enqueueBackupPending,
  kick,
  stop,
};
