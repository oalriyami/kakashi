const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const READMES = ['README.md', 'README.ar.md'];

/** A token Kakashi emits, e.g. `[DB_CONN_2]`. */
const TOKEN_RX = /\[[A-Z][A-Z0-9_]*_\d+\]/;
/** A hand-written stand-in, e.g. `[EMAIL_EXAMPLE]`. */
const PLACEHOLDER_RX = /\[[A-Z][A-Z0-9_]*_EXAMPLE\]/;

/**
 * The READMEs once went through the masker, which replaced every example
 * VALUE with a token: `kakashi db-scan "[DB_CONN_2]"`, a connection-string
 * table of `[DB_CONN_5]`, and a "What Kakashi Catches" table showing tokens on
 * both sides of the arrow (issue #18). Tokens belong on the OUTPUT side of an
 * example only; these checks keep it that way.
 */
function runDocsTests() {
  let passed = 0;
  let failed = 0;
  function check(name, fn) {
    try {
      fn();
      passed++;
    } catch (err) {
      console.error(`FAIL ${name}: ${err.message}`);
      failed++;
    }
  }

  for (const file of READMES) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    const where = (i) => `${file}:${i + 1}: ${lines[i].trim().slice(0, 80)}`;
    const offending = (test) => lines.map((l, i) => (test(l) ? where(i) : null)).filter(Boolean);

    check(`${file} has no [..._EXAMPLE] placeholders`, () => {
      const bad = offending((l) => PLACEHOLDER_RX.test(l));
      assert.deepStrictEqual(bad, []);
    });

    check(`${file} example inputs are values, not tokens`, () => {
      // `value → [TOKEN_1]`: the left side is the input.
      const bad = offending((l) => l.includes('→') && TOKEN_RX.test(l.split('→')[0]));
      assert.deepStrictEqual(bad, []);
    });

    check(`${file} commands take real arguments, not tokens`, () => {
      const bad = offending((l) => /\bkakashi\s+[a-z-]+\b/.test(l)
        && TOKEN_RX.test(l.split(/\s#\s/)[0]));
      assert.deepStrictEqual(bad, []);
    });

    check(`${file} before/after diffs show the original on the "-" side`, () => {
      const bad = offending((l) => /^- \S/.test(l) && TOKEN_RX.test(l) && !l.includes('→'));
      assert.deepStrictEqual(bad, []);
    });

    check(`${file} table rows have balanced backticks`, () => {
      const bad = offending((l) => l.trimStart().startsWith('|') && (l.match(/`/g) || []).length % 2 === 1);
      assert.deepStrictEqual(bad, []);
    });
  }

  // -------------------------------------------------------------------------
  // Agent support claims must match the installer (issue #19). The README once
  // listed 15 agents with `--only <id>` commands while the installer knew 7, and
  // an unknown id silently installed nothing.
  // -------------------------------------------------------------------------
  const installer = fs.readFileSync(path.join(ROOT, 'bin', 'install.js'), 'utf8');
  const agentsBlock = installer.slice(installer.indexOf('const AGENTS = ['), installer.indexOf('];', installer.indexOf('const AGENTS = [')));
  const installable = new Set([...agentsBlock.matchAll(/id: '([\w-]+)'/g)].map((m) => m[1]));

  check('installer declares its agents', () => assert(installable.size >= 7, `found ${installable.size}`));

  for (const file of [...READMES, 'INSTALL.md']) {
    check(`${file}: every --only <id> is an agent the installer knows`, () => {
      const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const named = [...body.matchAll(/--only[ =]([\w,-]+)/g)].flatMap((m) => m[1].split(','));
      const unknown = named.filter((id) => !installable.has(id));
      assert.deepStrictEqual(unknown, []);
    });
  }

  check('README makes no "20+ agents" claim', () => {
    for (const file of [...READMES, 'package.json', path.join('skills', 'kakashi', 'SKILL.md')]) {
      const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert(!/20\+ (?:AI |agentic )?(?:coding )?agents|agents-20%2B|أكثر من 20 وكيل/.test(body), `${file} still claims 20+ agents`);
    }
  });

  check('installer rejects an unknown --only id', () => {
    const { spawnSync } = require('child_process');
    const os = require('os');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-install-'));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.js'), '--only', 'aider', '--dry-run'],
      { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.status, 1, `exit ${r.status}`);
    assert(/Unknown agent id: aider/.test(r.stderr), r.stderr);
  });

  console.log(`docs.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runDocsTests };

if (require.main === module) {
  process.exit(runDocsTests() ? 0 : 1);
}
