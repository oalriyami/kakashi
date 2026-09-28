/**
 * Which files a folder command looks at -- shared by `scan-dir` and
 * `mask-dir`, so the two never disagree about what is in scope (#51).
 *
 * Exclusions, in order:
 *
 *   1. Always: dependency trees and version-control folders, and Kakashi's
 *      own `masked_` copies. `mask-dir` used to walk `.git` and write
 *      `.git/hooks/masked_pre-push.sh`.
 *   2. `--exclude` patterns, ADDED to (1). They used to replace it, so
 *      `--exclude '*.log'` quietly brought `node_modules` back in.
 *   3. `.gitignore` and `.kakashiignore`, in the root and in every folder
 *      below it, unless the caller turns them off. A deeper file's rules
 *      override a shallower one's, and a later rule overrides an earlier one,
 *      as in git.
 *
 * Patterns follow .gitignore syntax (via the `ignore` package): `b/` is the
 * folder `b` at any depth, `*.log` any .log file at any depth, `/build` only
 * the top-level build, `!keep.log` re-includes. The old hand translation made
 * `b/` and `*.log` match only at the top level and mangled `!` negation.
 */

const fs = require('fs');
const path = require('path');
const { glob } = require('glob');
const ignore = require('ignore');

/** Always excluded. */
const DEFAULT_EXCLUDES = ['node_modules/', '.git/', '.hg/', '.svn/', 'masked_*'];

/** Files whose rules are honoured when ignore files are on. */
const IGNORE_FILES = ['.gitignore', '.kakashiignore'];

function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

/**
 * Build the exclusion test for a tree.
 * @param {string} root
 * @param {object} [opts]
 * @param {boolean} [opts.ignoreFiles=true] - honour .gitignore / .kakashiignore
 * @param {string[]} [opts.exclude=[]] - extra .gitignore-syntax patterns
 * @returns {{ excluded(abs: string, isDir: boolean): false|'default'|'ignore-file' }}
 */
function exclusions(root, { ignoreFiles = true, exclude = [] } = {}) {
  const absRoot = path.resolve(root);
  const always = ignore().add(DEFAULT_EXCLUDES).add(exclude.filter(Boolean));
  const perDir = new Map(); // folder -> ignore instance, or null when it has no rules

  function rulesIn(dir) {
    if (perDir.has(dir)) return perDir.get(dir);
    let rules = null;
    for (const name of IGNORE_FILES) {
      let text;
      try {
        text = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        continue;
      }
      rules = (rules || ignore()).add(text);
    }
    perDir.set(dir, rules);
    return rules;
  }

  function excluded(abs, isDir) {
    const rel = path.relative(absRoot, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    const slash = isDir ? '/' : '';
    if (always.ignores(toPosix(rel) + slash)) return 'default';
    if (!ignoreFiles) return false;
    // Walk from the root down to the file's own folder; each folder's rules
    // apply to the path below it, and the deepest verdict wins.
    const parts = rel.split(path.sep);
    let dir = absRoot;
    let verdict = false;
    for (let i = 0; i < parts.length; i++) {
      const rules = rulesIn(dir);
      if (rules) {
        const r = rules.test(parts.slice(i).join('/') + slash);
        if (r.ignored) verdict = true;
        else if (r.unignored) verdict = false;
      }
      dir = path.join(dir, parts[i]);
    }
    return verdict ? 'ignore-file' : false;
  }

  return { excluded };
}

/** glob's `ignore` option: prune excluded folders, drop excluded files. */
function globIgnore(ex) {
  return {
    ignored: (p) => Boolean(ex.excluded(p.fullpath(), p.isDirectory())),
    childrenIgnored: (p) => Boolean(ex.excluded(p.fullpath(), true)),
  };
}

/**
 * The files under `root` that match `patterns` and are not excluded.
 * @param {string} root
 * @param {string|string[]} patterns - glob patterns relative to root
 * @param {object} [opts]
 * @param {boolean} [opts.ignoreFiles=true]
 * @param {string[]} [opts.exclude=[]]
 * @param {boolean} [opts.countIgnored=false] - also count the files the
 *   ignore FILES left out (not the defaults or --exclude)
 * @returns {Promise<{ files: string[], skippedByIgnoreFile: number }>}
 */
async function discoverFiles(root, patterns, opts = {}) {
  const { ignoreFiles = true, exclude = [], countIgnored = false } = opts;
  // dot: true -- hidden files are where credentials live (`.env`). nocase:
  // `REPORT.CSV` is a CSV.
  const globOpts = { cwd: root, absolute: true, nodir: true, dot: true, nocase: true };
  const ex = exclusions(root, { ignoreFiles, exclude });
  const files = await glob(patterns, { ...globOpts, ignore: globIgnore(ex) });
  let skippedByIgnoreFile = 0;
  if (countIgnored && ignoreFiles) {
    const withoutFiles = exclusions(root, { ignoreFiles: false, exclude });
    const all = await glob(patterns, { ...globOpts, ignore: globIgnore(withoutFiles) });
    skippedByIgnoreFile = all.length - files.length;
  }
  return { files: files.sort(), skippedByIgnoreFile };
}

module.exports = { discoverFiles, exclusions, globIgnore, DEFAULT_EXCLUDES, IGNORE_FILES };
