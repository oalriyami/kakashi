/**
 * Writing output files without following planted links (#33).
 *
 * Every Kakashi writer used to call `fs.writeFileSync(outputPath, …)` (or a
 * write stream, or `copyFileSync`), and all of those FOLLOW a symbolic link at
 * the destination. A repository only has to contain `masked_config.env ->
 * ~/.bashrc` -- git stores symlinks -- and the documented `mask-dir -r` writes
 * the masked copy of `config.env` into the user's shell start-up file. The same
 * held for `mask -o`, `db-mask`, `scan-dir -o`, `impact --write`, agent-guard's
 * `--auto-mask` and Guardian's release copy.
 *
 * Two guards, because either alone leaves a gap:
 *
 *   1. The destination is checked with lstat: a symbolic link, or anything
 *      that is not a regular file (a directory, a FIFO, a device), is refused
 *      with a clear message.
 *   2. The data is written to a new temporary file in the same folder -- opened
 *      with O_CREAT|O_EXCL, so it can never be an existing file or link -- and
 *      then renamed over the destination. A rename replaces the directory entry
 *      itself and never follows a link there, so a link planted between the
 *      check and the write still cannot redirect it. It also means a reader
 *      never sees a half-written file.
 *
 * A file being replaced keeps its permission bits.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class UnsafeOutputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeOutputError';
  }
}

/**
 * Refuse a destination that is a link or not a regular file.
 * @param {string} outputPath
 * @returns {fs.Stats|null} the existing file's stats, or null if it does not exist
 */
function checkTarget(outputPath) {
  let st;
  try {
    st = fs.lstatSync(outputPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new UnsafeOutputError(`refusing to write through a symbolic link: ${outputPath}`);
  }
  if (!st.isFile()) {
    throw new UnsafeOutputError(`refusing to write over something that is not a regular file: ${outputPath}`);
  }
  return st;
}

function tempPathFor(outputPath) {
  const suffix = `${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  return path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${suffix}`);
}

/** Move a finished temporary file into place, keeping an existing file's mode. */
function commit(tmp, outputPath, existing) {
  if (existing) fs.chmodSync(tmp, existing.mode & 0o7777);
  fs.renameSync(tmp, outputPath);
}

/**
 * Write a whole file safely.
 * @param {string} outputPath
 * @param {string|Buffer} data
 * @param {object|string} [options] - as for fs.writeFileSync (encoding, mode)
 */
function writeFileSafe(outputPath, data, options) {
  const existing = checkTarget(outputPath);
  const tmp = tempPathFor(outputPath);
  const opts = typeof options === 'string' ? { encoding: options } : { ...(options || {}) };
  try {
    fs.writeFileSync(tmp, data, { ...opts, flag: 'wx' });
    commit(tmp, outputPath, existing);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * A write stream for an output built up incrementally (db-mask). Nothing
 * appears at `outputPath` until `finish()` resolves; `abort()` leaves no trace.
 * @param {string} outputPath
 * @returns {{ stream: fs.WriteStream, finish: () => Promise<void>, abort: () => void }}
 */
function createWriteStreamSafe(outputPath) {
  const existing = checkTarget(outputPath);
  const tmp = tempPathFor(outputPath);
  const stream = fs.createWriteStream(tmp, { flags: 'wx' });
  let failed = null;
  stream.on('error', (err) => { failed = err; });
  return {
    stream,
    finish() {
      return new Promise((resolve, reject) => {
        stream.end(() => {
          if (failed) {
            fs.rmSync(tmp, { force: true });
            reject(failed);
            return;
          }
          try {
            commit(tmp, outputPath, existing);
            resolve();
          } catch (err) {
            fs.rmSync(tmp, { force: true });
            reject(err);
          }
        });
      });
    },
    abort() {
      stream.destroy();
      fs.rmSync(tmp, { force: true });
    },
  };
}

module.exports = { writeFileSafe, createWriteStreamSafe, checkTarget, UnsafeOutputError };
