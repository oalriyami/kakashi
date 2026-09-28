const fs = require('fs');
const path = require('path');
const os = require('os');

// Read the version from package.json once at load time. Hardcoding it here
// silently drifts when a release bumps the version and forgets to update this
// file — which is exactly what happened between 1.1.0 and 1.2.0. A `require`
// on package.json is cheap, works from a global npm install (npm resolves it
// relative to the module file), and cannot get out of sync.
const { version: PKG_VERSION } = require('../../package.json');

const STATS_DIR = path.join(os.homedir(), '.kakashi');
const STATS_FILE = path.join(STATS_DIR, 'stats.json');

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    }
  } catch {
    /* ignore */
  }
  return { filesMasked: 0, totalFindings: 0, byCategory: { id: 0, pii: 0, cred: 0 } };
}

function saveStats(stats) {
  fs.mkdirSync(STATS_DIR, { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf8');
}

function recordMask(findings) {
  const byCategory = {};
  for (const f of findings) byCategory[f.cat] = (byCategory[f.cat] || 0) + 1;
  return recordCounts({ total: findings.length, byCategory });
}

/**
 * Count one masked file from totals alone -- for a caller that keeps counts
 * rather than findings (the Guardian, #48).
 * @param {{ total: number, byCategory: Object<string, number> }} counts
 */
function recordCounts({ total, byCategory = {} }) {
  const stats = loadStats();
  stats.filesMasked += 1;
  stats.totalFindings += total;
  if (!stats.byCategory) stats.byCategory = { id: 0, pii: 0, cred: 0 };
  // Migrate legacy 'uae' bucket if present in older stats files
  if (stats.byCategory.uae != null) {
    stats.byCategory.id = (stats.byCategory.id || 0) + stats.byCategory.uae;
    delete stats.byCategory.uae;
  }
  for (const [cat, n] of Object.entries(byCategory)) {
    stats.byCategory[cat] = (stats.byCategory[cat] || 0) + n;
  }
  saveStats(stats);
  return stats;
}

/**
 * Produce a privacy-preserving impact snapshot suitable for voluntary
 * contribution to the public adoption dashboard (B5).
 *
 * The snapshot contains ONLY:
 *   - the cumulative counts already in stats.json (no filenames, no values)
 *   - a coarse timestamp bucket (YYYY-MM, not YYYY-MM-DD, to blunt correlation)
 *   - kakashi version + node platform (for stability metrics)
 *
 * There is no auto-submission. The user runs `kakashi impact --write path`
 * and gets a JSON file they can inspect and voluntarily attach to a GitHub
 * issue. Kakashi never phones home — this preserves the "zero network
 * calls" guarantee while still giving the community a way to see aggregate
 * impact if enough users choose to share.
 */
function impactSnapshot() {
  const stats = loadStats();
  const now = new Date();
  return {
    schema: 'kakashi.impact.v1',
    generatedAt: now.toISOString(),
    // Coarser bucket so a stream of contributions cannot be correlated by exact minute.
    bucket: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
    filesMasked: stats.filesMasked || 0,
    totalFindings: stats.totalFindings || 0,
    byCategory: stats.byCategory || { id: 0, pii: 0, cred: 0 },
    kakashiVersion: PKG_VERSION,
    platform: process.platform, // linux | darwin | win32
    // NOTE: no filenames, no paths, no directory names, no pattern-instance
    // counts (only category totals). No user id, no machine id.
  };
}

module.exports = {
  STATS_DIR,
  STATS_FILE,
  loadStats,
  saveStats,
  recordMask,
  recordCounts,
  impactSnapshot,
};
