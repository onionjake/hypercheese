'use strict';
// Each fake "native" call (expo-sqlite query, queue DB write, file stat)
// resolves ~1ms later on a timer, like a JSI/bridge async call returning
// from a native thread. That lets React's scheduled render run in between,
// so the app's `await`s split work into separate React batches the way they
// do on device. The wait is idle time, so it never counts as busy time.
const realSetTimeout = require('timers').setTimeout;
const io = { pending: 0, latencyMs: 1 };
function hop(value) {
  io.pending++;
  return new Promise((resolve) =>
    realSetTimeout(() => {
      io.pending--;
      resolve(value);
    }, io.latencyMs)
  );
}
module.exports = { io, hop };
