const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RULE_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  path.join('src', 'rules', 'kakashi-activate.md'),
];

function runAgentRuleTests() {
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

  const requiredCommands = [
    'scan-dir',
    'mask-dir',
    'db-scan',
    'db-mask',
    'db-audit',
    'guard',
    'agent-guard',
  ];

  for (const relativePath of RULE_FILES) {
    check(`${relativePath} teaches every protection surface`, () => {
      const body = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
      for (const command of requiredCommands) {
        assert(body.includes(`\`${command}`) || body.includes(`kakashi ${command}`),
          `${relativePath} is missing ${command}`);
      }
      assert(body.includes('REQUIRE_APPROVAL'), `${relativePath} is missing Guardian decisions`);
      assert(body.includes('exit `3`'), `${relativePath} is missing Guardian exit-code guidance`);
      assert(body.includes('--include-values'), `${relativePath} is missing unsafe-report guidance`);
    });
  }

  // -------------------------------------------------------------------------
  // The rules tell agents which `guard --json` fields to narrate from. Those
  // fields must exist in the real output, for every decision, or an agent
  // following the rules finds nothing and improvises (issue #17).
  // -------------------------------------------------------------------------
  const GUARD_RULE_FILES = [...RULE_FILES, path.join('commands', 'kakashi-guard.md')];
  const documented = new Set();
  for (const relativePath of GUARD_RULE_FILES) {
    const body = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    // The field list is the run of backticked names that includes `plan.actions`.
    const list = body.match(/(?:`[\w.[\]]+`,?\s*){4,}/g) || [];
    const fields = list.find((l) => l.includes('`plan.actions`'));
    check(`${relativePath} lists the guard --json fields`, () => assert(fields, 'field list not found'));
    if (fields) for (const m of fields.matchAll(/`([\w.]+)(?:\[\])?`/g)) documented.add(m[1]);
  }

  const { spawnSync } = require('child_process');
  const os = require('os');
  const { maskText } = require('../src/engine/masker');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-rules-'));
  const runs = [
    ['ALLOW_WITH_TRANSFORMATION', 'guardian_employees.md', ['--agent', 'claude', '--task', 'calculate average salary by age group']],
    ['REQUIRE_APPROVAL', 'guardian_service.env', ['--agent', 'unknown']],
  ];
  for (const [want, fixture, args] of runs) {
    const src = path.join(ROOT, 'tests', 'fixtures', fixture);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'kakashi.js'), 'guard', src, ...args,
      '--json', '--no-audit', '--output', path.join(tmp, `guarded_${fixture}`)], { encoding: 'utf8' });
    check(`guard --json (${want}) has every field the rules name`, () => {
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.decision, want);
      assert(documented.size >= 8, `only found ${documented.size} documented fields`);
      for (const field of documented) {
        let node = out;
        for (const part of field.split('.')) {
          assert(node !== null && typeof node === 'object' && part in node, `missing ${field}`);
          node = node[part];
        }
      }
      assert(Array.isArray(out.plan.actions) && Array.isArray(out.verifications));
    });
    check(`guard --json (${want}) carries no detected value`, () => {
      const originals = maskText(fs.readFileSync(src, 'utf8')).findings.map((f) => f.original);
      for (const o of originals) assert(!r.stdout.includes(o), `leaked a detected value (${o.length} chars)`);
    });
  }

  console.log(`agent-rules.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runAgentRuleTests };

if (require.main === module) {
  process.exit(runAgentRuleTests() ? 0 : 1);
}
