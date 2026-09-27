/**
 * The thread agent-guard scans and masks files on (#38).
 *
 * Detection runs in this worker, never on the daemon's own thread, so a file
 * that takes long to check cannot stall /health or other requests, and one
 * that takes too long can be stopped: the daemon terminates this thread and
 * starts a fresh one. Only counts and summaries are posted back; finding
 * values never leave the worker.
 */

const { parentPort, workerData } = require('worker_threads');
const { scanFile, maskFile, DEFAULTS } = require('./guard');
const { maskText } = require('../engine/masker');

// The daemon's limits, not whatever this thread would read for itself.
Object.assign(DEFAULTS, workerData);

parentPort.on('message', async ({ id, op, input, output }) => {
  try {
    if (op === 'scan') {
      const r = await scanFile(input);
      parentPort.postMessage({ id, result: r.skipped ? r : { path: r.path, summary: r.summary } });
    } else {
      const r = await maskFile(input, output);
      parentPort.postMessage({ id, result: { output: r.output, replacements: r.findings.length } });
    }
  } catch (err) {
    parentPort.postMessage({ id, error: { message: err.message, status: err.status } });
  }
});

// Load the name lists and the format readers now, so that start-up is not
// charged to the first file against its time limit.
maskText('Dear Rajesh Kumar');
for (const reader of ['xlsx', 'docx', 'pptx', 'pdf']) require(`../engine/formats/${reader}`);
parentPort.postMessage({ ready: true });
