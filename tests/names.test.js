const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { maskText } = require('../src/engine/masker');
const { PATTERNS, isOrgOrPlace } = require('../src/engine/patterns');
const { classifyKey, normalizeKey } = require('../src/engine/person-fields');
const { occurrences, replaceOccurrences } = require('../src/engine/formats/replace');
const ooxml = require('../src/engine/formats/ooxml');
const formats = require('../src/engine/formats');

const NAME_IDS = new Set(['full_name', 'non_latin_name']);
const NAME_PATTERNS = PATTERNS.filter((p) => NAME_IDS.has(p.id));

/** Every name the engine finds in `text`, as the original strings. */
function names(text) {
  return maskText(text, { patterns: NAME_PATTERNS }).findings.map((f) => f.original);
}

// ---------------------------------------------------------------------------
// Benchmark data. Synthetic names whose origins mirror the UAE workforce, the
// contexts names really arrive in, and texts with no person in them at all.
// ---------------------------------------------------------------------------

const BENCH_NAMES = [
  ['محمد بن راشد', 'محمد'], ['فاطمة الكعبي', 'فاطمة'], ['عبدالله المنصوري', 'عبدالله'],
  ['Mohammed Al Mansouri', 'Mohammed'], ['Fatima Al-Kaabi', 'Fatima'], ['Abdulla bin Rashid', 'Abdulla'],
  ['Mohamed Salem', 'Mohamed'], ['Maitha Al Shamsi', 'Maitha'], ['Hamdan Al Falasi', 'Hamdan'],
  ['Rajesh Kumar', 'Rajesh'], ['Priya Nair', 'Priya'], ['Maria Santos', 'Maria'], ['Jose dela Cruz', 'Jose'],
  ['Sarah Connor', 'Sarah'], ["James O'Brien", 'James'], ['Grace Hopper', 'Grace'],
];

const isArabicName = (n) => /[\u0600-\u06FF]/.test(n);

/**
 * Each context makes a text with one name in it and says what must be found.
 * `exact` contexts need a finding equal to `want` on its own, not a longer
 * finding that happens to contain it.
 */
const BENCH_CONTEXTS = {
  'prose':             (n) => ({ text: `Please send the signed contract to ${n} before Thursday.`, want: n }),
  'form label':        (n) => ({ text: `Name: ${n}\nNationality: UAE`, want: n }),
  'CSV column':        (n) => ({ text: `id,full_name,department\n1017,${n},Finance`, want: n }),
  'JSON row':          (n) => ({ text: JSON.stringify({ id: 1017, full_name: n, department: 'Finance' }, null, 2), want: n }),
  'ALL CAPS export':   (n) => ({ text: `ID,HOLDER NAME,EXPIRY\n1017,${n.toUpperCase()},2027-03-01`, want: n.toUpperCase() }),
  'lowercase field':   (n) => ({ text: `ticket: 4411\nassignee: ${n.toLowerCase()}\nstatus: open`, want: n.toLowerCase() }),
  'first name column': (n, first) => ({
    text: `Name,Team\n${first},Ops\nAhmed Hassan,Finance\nLayla Haddad,Legal\nOmar Khalid,HR`, want: first,
  }),
  // Phase 2 (#12): evidence from the name list rather than from structure.
  'lowercase prose':   (n) => ({ text: `please ask ${n.toLowerCase()} to review the draft.`, want: n.toLowerCase() }),
  'Arabic prose':      (n) => ({ text: `يرجى إرسال العقد إلى ${n} قبل يوم الخميس.`, want: n }),
  'greeting':          (n, first) => ({
    text: isArabicName(first) ? `شكرا ${first}، تم استلام الملف.` : `Thanks, ${first}. The file arrived.`, want: first, exact: true,
  }),
  'repeated first name': (n, first) => ({
    text: isArabicName(first)
      ? `انضم ${n} إلى الفريق في 2019.\nيقود ${first} الآن فريق التدقيق.`
      : `${n} joined the team in 2019.\nToday ${first} leads the audit team.`,
    want: first,
    exact: true,
  }),
};

const BENCH_NEGATIVES = [
  'Our offices are in Abu Dhabi, Al Ain and Ras Al Khaimah.',
  'Flights to New York and San Francisco are delayed.',
  'Transfer via Abu Dhabi Commercial Bank.',
  'Deployed on Google Cloud with Visual Studio Code.',
  'Machine Learning Quarterly Revenue Report',
  'Please Contact Support for help.',
  'The Dubai Marina project starts in March.',
  'Premium Plan renews monthly.',
  '{"company_name": "Acme Trading LLC", "product_name": "Premium Plan"}',
  '{"file_name": "report.pdf", "host_name": "db01"}',
  'company_name,city\nGulf Logistics FZE,Dubai',
  'Owner: Finance Department',
  'Owner: Gulf Logistics LLC',
  'Sultan Bin Zayed Street',
  'King Abdullah Economic City',
  'Mohammed Bin Rashid Boulevard',
  'Status: approved\nPriority: high',
  'full_name: N/A',
  'const userName = getUserName(req);',
  '{"name": "@muhammadatef/kakashi", "version": "1.3.1"}',
  'name: CI\njobs:\n  test:\n    steps:\n      - name: Install dependencies\n      - name: Set up Node\n      - name: Run tests',
  'metadata:\n  name: payment-service\n  namespace: prod',
  '| Pattern | Regex |\n|---|---|\n| email | x |\n| phone | y |',
  'أبو ظبي',
  'مرحبا بكم في دبي',
  'تم تحديث النظام بنجاح',
  'يرجى مراجعة التقرير المرفق قبل الاجتماع',
  // Phase 2 (#12): product catalogues, greetings without a name, name-words in
  // ordinary text, ALL-CAPS and hyphenated headings, and more Arabic prose --
  // including sentences that open with a word that is also a name (أمل, حسن,
  // سعيد, نور).
  'name,price\nwireless mouse,25\nusb cable,5\ncoffee maker,40\nlaptop stand,60',
  'NAME,QTY\nWIRELESS MOUSE,2\nUSB CABLE,1\nLAPTOP STAND,1',
  '| Name | Price |\n|---|---|\n| Premium Plan | 99 |\n| Basic Plan | 19 |\n| Team Plan | 49 |',
  'Hi team, thanks all.',
  'Dear Customer, your order has shipped.',
  'the grace period ends in may',
  'mark the price as final and hope for the best',
  'QUARTERLY REVENUE REPORT',
  'Real-World Validation of Cross-Border Transfers',
  'أمل كبير في نجاح المشروع',
  'حسن الأداء مطلوب من جميع الموظفين',
  'سعيد بلقائكم اليوم',
  'نور الشمس قوي في الصيف',
  'شكرا لكم على التعاون',
  'تمت الموافقة على الطلب',
  'يرجى التواصل مع خدمة العملاء',
];

/**
 * Floors ratchet: raise them when detection improves, never lower them to make
 * a change pass.
 *   main:     recall 54/112 on the first 7 contexts, 19/27 negatives flagged.
 *   phase 1:  person fields and the place veto -- 108/112, 3/27 (all Arabic
 *             prose).
 *   phase 2:  the name list (#12) -- 112/112 on those contexts, 176/176 with
 *             the 4 list-based contexts added, and 0 of 43 negatives flagged
 *             (the 27 before plus 16 new ones).
 */
const RECALL_FLOOR = 176;
const FALSE_ALARM_CEILING = 0;

function runBenchmark() {
  const rows = [];
  let found = 0;
  let total = 0;
  for (const [ctx, make] of Object.entries(BENCH_CONTEXTS)) {
    let hit = 0;
    for (const [full, first] of BENCH_NAMES) {
      const { text, want, exact } = make(full, first);
      if (names(text).some((n) => n === want || (!exact && n.includes(want)))) hit++;
    }
    rows.push([ctx, hit]);
    found += hit;
    total += BENCH_NAMES.length;
  }
  const flagged = BENCH_NEGATIVES.filter((t) => names(t).length > 0);
  return { rows, found, total, flagged };
}

async function runNameTests() {
  let passed = 0;
  let failed = 0;
  async function check(name, fn) {
    try {
      await fn();
      passed++;
    } catch (err) {
      console.error(`FAIL ${name}: ${err.message}`);
      failed++;
    }
  }

  // --- keys ----------------------------------------------------------------
  await check('normalizeKey handles camelCase, spaces and language suffixes', () => {
    assert.strictEqual(normalizeKey('firstName'), 'first_name');
    assert.strictEqual(normalizeKey('"Full Name"'), 'full_name');
    assert.strictEqual(normalizeKey('name_ar'), 'name');
    assert.strictEqual(normalizeKey('الاسم الكامل'), 'الاسم_الكامل');
  });

  await check('classifyKey grades person keys and rejects thing keys', () => {
    const cases = [
      ['full_name', 'strong'], ['Surname', 'strong'], ['employee_name', 'strong'],
      ['patientName', 'strong'], ['emp_first_name', 'strong'], ['Card Holder', 'strong'],
      ['الاسم الكامل', 'strong'], ['اسم الموظف', 'strong'],
      ['name', 'weak'], ['Owner', 'weak'], ['assignee', 'weak'], ['الاسم', 'weak'],
      ['company_name', null], ['file_name', null], ['hostName', null], ['product', null],
      ['username', null], ['agent_name', null], ['اسم الشركة', null], ['id', null],
    ];
    for (const [key, want] of cases) assert.strictEqual(classifyKey(key), want, key);
  });

  // --- field detection -----------------------------------------------------
  const FIELD_CASES = [
    // [description, text, expected names]
    ['JSON strong key, capitals', '{"full_name": "MOHAMMED AL MANSOURI"}', ['MOHAMMED AL MANSOURI']],
    ['JSON strong key, single name', '{"first_name": "Will", "last_name": "Price"}', ['Will', 'Price']],
    ['Python dict', "{'customer_name': 'layla haddad'}", ['layla haddad']],
    ['label line, lowercase', 'Name: sarah connor\nNationality: UAE', ['sarah connor']],
    ['YAML weak key with a person', 'assignee: Priya Nair', ['Priya Nair']],
    ['assignment', 'const customerName = "ali"', ['ali']],
    ['CSV strong column, any case', 'id,full_name,dept\n1,fatima al-kaabi,HR\n2,"Connor, Sarah",IT', ['fatima al-kaabi', 'Connor, Sarah']],
    ['Markdown table weak column promoted', '| Name | Email |\n|---|---|\n| Ahmed Hassan | a |\n| Fatima | b |\n| Omar Khalid | c |', ['Ahmed Hassan', 'Fatima', 'Omar Khalid']],
    ['TSV', 'Surname\tDept\nAl Mansouri\tHR\nKumar\tIT', ['Al Mansouri', 'Kumar']],
    ['Arabic key', '{"اسم الموظف": "ميثاء الشامسي"}', ['ميثاء الشامسي']],
    ['DB row as the db path serialises it', JSON.stringify({ id: 7, full_name: 'rajesh kumar' }, null, 2), ['rajesh kumar']],
    // Negatives
    ['weak key, workflow step', '- name: Set up Node', []],
    ['weak key, single word', 'name: payment-service', []],
    ['package.json name', '{"name": "@muhammadatef/kakashi"}', []],
    ['placeholder', 'full_name: N/A', []],
    ['org under a person key', 'full_name: Gulf Logistics LLC', []],
    ['value with digits', '{"full_name": "user_1234"}', []],
    ['thing key', 'company_name,city\nAcme Trading,Dubai', []],
    // `deploy production` alone would pass the weak test; the document's other
    // `name:` values show the key labels steps, so it is demoted.
    ['weak key demoted when most values are not people', 'name: CI\nsteps:\n  - name: checkout\n  - name: deploy production\n  - name: run tests', []],
  ];
  for (const [desc, text, want] of FIELD_CASES) {
    await check(`person fields: ${desc}`, () => {
      const got = names(text);
      for (const w of want) assert(got.includes(w), `expected ${JSON.stringify(w)} in ${JSON.stringify(got)}`);
      if (want.length === 0) assert.deepStrictEqual(got, []);
    });
  }

  await check('person-field spans are exact and masking keeps JSON valid', () => {
    const text = JSON.stringify([{ full_name: 'AHMED HASSAN' }, { full_name: 'ahmed hassan' }]);
    const { masked } = maskText(text);
    const parsed = JSON.parse(masked);
    assert.match(parsed[0].full_name, /^\[FULL_NAME_\d+\]$/);
    assert.match(parsed[1].full_name, /^\[FULL_NAME_\d+\]$/);
  });

  await check('person fields respect the whitelist and the enabled filter', () => {
    const text = '{"full_name": "JOHN DOE"}';
    assert.deepStrictEqual(maskText(text, { whitelist: ['JOHN DOE'] }).findings, []);
    assert.deepStrictEqual(maskText(text, { enabled: ['email'] }).findings, []);
    assert.strictEqual(maskText(text, { enabled: ['full_name'] }).findings.length, 1);
  });

  // --- place and organisation veto ------------------------------------------
  await check('isOrgOrPlace recognises places and organisations', () => {
    for (const p of ['Abu Dhabi', 'Ras Al Khaimah', 'Visit Abu Dhabi', 'Sultan Bin Zayed Street',
      'Gulf Logistics LLC', 'Visual Studio Code', 'Finance Department', 'شارع الشيخ زايد', 'أبو ظبي']) {
      assert(isOrgOrPlace(p.split(' ')), p);
    }
    for (const p of ['Ahmed Hassan', 'Grace Park', 'Sarah Hall', 'Mohammed Al Mansouri', 'محمد بن راشد']) {
      assert(!isOrgOrPlace(p.split(' ')), p);
    }
  });

  await check('the veto outranks a name cue, and a cue still rescues ordinary words', () => {
    assert.deepStrictEqual(names('Owner: Gulf Logistics LLC'), []);
    assert.deepStrictEqual(names('Customer: Sultan Bin Zayed Street'), []);
    assert(names('Name: Mark Price').includes('Mark Price'));
  });

  // --- whole-word replacement ------------------------------------------------
  await check('writers replace names as whole words only', () => {
    assert.deepStrictEqual(occurrences('Ali and Alignment, Khalil, ali', 'Ali'), [0]);
    assert.strictEqual(replaceOccurrences('Ali (Alibaba) Ali', 'Ali', '[N]'), '[N] (Alibaba) [N]');
    assert.deepStrictEqual(occurrences('محمد ومحمد', 'محمد'), [0]);
  });

  await check('writers keep substring replacement for secrets', () => {
    const secret = ['hunter', '2prod'].join('');
    assert.deepStrictEqual(occurrences(`pw=${secret}; x${secret}y`, secret), [3, 17]);
    assert.strictEqual(replaceOccurrences('a@b.co,a@b.co', 'a@b.co', '[E]'), '[E],[E]');
  });

  await check('docx paragraph masking does not corrupt words containing a name', () => {
    const SPEC = { textTag: 'w:t', paraTag: 'w:p' };
    const xml = '<w:p><w:r><w:t>Ali leads Alignment</w:t></w:r></w:p>';
    const out = ooxml.maskXml(xml, { Ali: '[FULL_NAME_1]' }, SPEC);
    assert(out.includes('[FULL_NAME_1] leads Alignment'), out);
  });

  // --- spreadsheets ---------------------------------------------------------
  await check('spreadsheet: header columns mask names in any case, nothing else is corrupted', async () => {
    const XLSX = require('xlsx');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-names-'));
    const src = path.join(tmp, 'staff.xlsx');
    const out = path.join(tmp, 'masked_staff.xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Full Name', 'Team', 'Notes'],
      ['MOHAMMED AL MANSOURI', 'Alignment', ''],
      ['fatima al-kaabi', 'Finance', 'reports to Ali'],
      ['Ali', 'Ops', 42],
    ]), 'Staff');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Code', 'City'], ['X1', 'Dubai']]), 'Sites');
    XLSX.writeFile(wb, src);

    const data = await formats.readFile(src);
    const { masked, findings } = maskText(data.text);
    // Every finding must be writable, i.e. contained in a single cell.
    const cellValues = Object.values(data.cells).flatMap((s) => Object.values(s));
    for (const f of findings) {
      assert(cellValues.some((v) => v.includes(f.original)), `finding spans cells: ${JSON.stringify(f.original)}`);
    }
    const replMap = {};
    for (const f of findings) replMap[f.original] = f.replacement;
    await formats.writeMasked(src, out, data, replMap, masked);

    const back = XLSX.readFile(out);
    const rows = XLSX.utils.sheet_to_json(back.Sheets.Staff, { header: 1 });
    const flat = rows.flat().map(String).join(' | ');
    for (const n of ['MOHAMMED AL MANSOURI', 'fatima al-kaabi']) assert(!flat.includes(n), `${n} survived: ${flat}`);
    assert.deepStrictEqual(rows[0], ['Full Name', 'Team', 'Notes'], 'header row untouched');
    assert.match(String(rows[3][0]), /^\[FULL_NAME_\d+\]$/, 'single-name cell masked');
    assert.strictEqual(String(rows[1][1]), 'Alignment', 'a word containing a masked name is untouched');
    assert(/reports to \[FULL_NAME_\d+\]/.test(String(rows[2][2])), `name in a note masked: ${rows[2][2]}`);
    const sites = XLSX.utils.sheet_to_json(back.Sheets.Sites, { header: 1 });
    assert.deepStrictEqual(sites, [['Code', 'City'], ['X1', 'Dubai']], 'other sheets untouched');
  });

  // --- phase 2: name list (#12) ----------------------------------------------
  const nameList = require('../src/engine/names');

  await check('name list: normalisation folds case, accents and Arabic letter forms', () => {
    assert.strictEqual(nameList.normalizeLatin('José'), 'jose');
    assert.strictEqual(nameList.normalizeLatin("O'Brien"), 'obrien');
    assert.strictEqual(nameList.normalizeLatin('MUḤAMMAD'), 'muhammad');
    assert.strictEqual(nameList.normalizeArabic('أحمد'), nameList.normalizeArabic('احمد'));
    assert.strictEqual(nameList.normalizeArabic('فاطمة'), 'فاطمه');
    assert.strictEqual(nameList.normalizeArabic('مُحَمَّد'), 'محمد');
    assert.strictEqual(nameList.normalizeArabic('محـــمد'), 'محمد');
    assert.strictEqual(nameList.stripFamilyPrefix(nameList.nameKey('Al-Kaabi')), 'kaabi');
    assert.strictEqual(nameList.stripFamilyPrefix(nameList.nameKey('الكعبي')), 'كعبي');
  });

  await check('name list: loads Wikidata names and the regional supplement', () => {
    const { given, family, ambiguous } = nameList.stats();
    assert(given > 40000 && family > 60000 && ambiguous > 1000, JSON.stringify(nameList.stats()));
    for (const n of ['James', 'Priya', 'Rajesh', 'Maitha', 'Mohamed', 'محمد', 'ميثاء', 'عبدالله']) {
      assert(nameList.isGivenName(n), `${n} should be a given name`);
    }
    for (const n of ['Kumar', 'Al-Kaabi', 'Mansouri', 'الكعبي', 'المنصوري', 'Haddad']) {
      assert(nameList.isFamilyName(n), `${n} should be a family name`);
    }
    for (const n of ['will', 'hope', 'Price', 'أمل', 'نور']) assert(nameList.isAmbiguousName(n), `${n} should be ambiguous`);
    for (const n of ['James', 'Mark', 'Grace', 'محمد']) assert(!nameList.isAmbiguousName(n), `${n} should not be ambiguous`);
    for (const n of ['team', 'customer', 'sir']) assert(!nameList.isKnownName(n), `${n} is not a name`);
  });

  const PHASE2_CASES = [
    // [description, text, expected names]
    ['Arabic span inside prose is exact', 'يرجى إرسال العقد إلى محمد بن راشد قبل الخميس', ['محمد بن راشد']],
    ['Gulf family name in the nisba form', 'تم تعيين فاطمة الكعبي مديرة للقسم', ['فاطمة الكعبي']],
    ['theophoric name on its own', 'عبد الله', ['عبد الله']],
    ['Arabic title makes one name enough', 'حضر السيد راشد الاجتماع', ['راشد']],
    ['Arabic comma does not glue onto a name', 'شكرا محمد، وصل الملف', ['محمد']],
    ['preposition على is not the name علي', 'حصل الفريق على الموافقة', []],
    ['ambiguous Arabic name opening a sentence', 'أمل كبير في نجاح المشروع', []],
    ['place starting with a nasab-like head', 'أبو ظبي وأم القيوين', []],
    ['Latin particles, hyphens and apostrophes', 'Ask Abdulla bin Rashid, Fatima Al-Kaabi and James O\'Brien.', ['Abdulla bin Rashid', 'Fatima Al-Kaabi', "James O'Brien"]],
    ['sentence opener trimmed', 'Today Rajesh Kumar joins.', ['Rajesh Kumar']],
    ['lower-case name in a log line', 'ticket 881 reassigned to priya nair by admin', ['priya nair']],
    ['ALL-CAPS name in running text', 'PAY TO RAJESH KUMAR BEFORE FRIDAY', ['RAJESH KUMAR']],
    ['greeting, title and sign-off', 'Dear Anil,\nDr Kumar will call.\nKind regards,\nMaitha', ['Anil', 'Kumar', 'Maitha']],
    ['everyday words that are also names', 'the grace period ends in may; will you mark the price?', []],
    ['greetings without a name', 'Hi team, thanks all. Dear Customer, hello world.', []],
    ['hyphenated heading', 'Real-World Validation of Cross-Border Transfers', []],
    ['product catalogue under a weak key', 'name,price\nwireless mouse,25\nusb cable,5\ncoffee maker,40', []],
  ];
  for (const [desc, text, want] of PHASE2_CASES) {
    await check(`phase 2: ${desc}`, () => {
      const got = names(text);
      for (const w of want) assert(got.includes(w), `expected ${JSON.stringify(w)} in ${JSON.stringify(got)}`);
      if (want.length === 0) assert.deepStrictEqual(got, []);
    });
  }

  await check('confidence: field and cue high, name list medium, Title Case alone low', () => {
    const conf = (text) => Object.fromEntries(maskText(text, { patterns: NAME_PATTERNS }).findings.map((f) => [f.original, f.confidence]));
    assert.deepStrictEqual(conf('{"full_name": "Zorblax Quendrin"}'), { 'Zorblax Quendrin': 'high' });
    assert.deepStrictEqual(conf('Customer: Zorblax Quendrin'), { 'Zorblax Quendrin': 'high' });
    assert.deepStrictEqual(conf('We met Zorblax Quendrin today.'), { 'Zorblax Quendrin': 'low' });
    assert.deepStrictEqual(conf('We met Rajesh Kumar today.'), { 'Rajesh Kumar': 'medium' });
    assert.deepStrictEqual(conf('يرجى إرسال العقد إلى محمد بن راشد'), { 'محمد بن راشد': 'medium' });
  });

  await check('minConfidence drops weaker name findings and keeps everything else', () => {
    const text = 'We met Zorblax Quendrin and Rajesh Kumar. Name: Ada Lovelace. mail a@b.co';
    const at = (min) => maskText(text, { minConfidence: min }).findings.map((f) => f.original).sort();
    assert.deepStrictEqual(at('low'), ['Ada Lovelace', 'Rajesh Kumar', 'Zorblax Quendrin', 'a@b.co']);
    assert.deepStrictEqual(at('medium'), ['Ada Lovelace', 'Rajesh Kumar', 'a@b.co']);
    assert.deepStrictEqual(at('high'), ['Ada Lovelace', 'a@b.co']);
  });

  await check('Guardian: every destination reads its name threshold, default low', async () => {
    const { rulesFor, POLICIES } = require('../src/guardian/policy');
    const { observe } = require('../src/guardian/observe');
    for (const d of Object.keys(POLICIES.default.destinations)) {
      assert.strictEqual(rulesFor('default', d).minNameConfidence, 'low', d);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-conf-'));
    const file = path.join(tmp, 'note.txt');
    fs.writeFileSync(file, 'We met Zorblax Quendrin and Rajesh Kumar.\n');
    const count = async (min) => (await observe(file, { minConfidence: min })).observation.totalFindings;
    assert.strictEqual(await count('low'), 2);
    assert.strictEqual(await count('medium'), 1);
    assert.strictEqual(await count('high'), 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // --- benchmark -------------------------------------------------------------
  await check('name benchmark: recall and false alarms do not regress', () => {
    const { rows, found, total, flagged } = runBenchmark();
    const detail = rows.map(([c, h]) => `${c} ${h}/${BENCH_NAMES.length}`).join(', ');
    console.log(`  name benchmark: recall ${found}/${total}; false alarms ${flagged.length}/${BENCH_NEGATIVES.length} (${detail})`);
    assert(found >= RECALL_FLOOR, `recall ${found} fell below ${RECALL_FLOOR}`);
    assert(flagged.length <= FALSE_ALARM_CEILING,
      `${flagged.length} false alarms, ceiling ${FALSE_ALARM_CEILING}: ${flagged.map((t) => JSON.stringify(t.slice(0, 40))).join(', ')}`);
  });

  console.log(`names.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runNameTests, runBenchmark, BENCH_NAMES, BENCH_CONTEXTS, BENCH_NEGATIVES };
