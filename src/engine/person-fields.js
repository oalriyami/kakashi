/**
 * Person fields -- find names by the field they sit in, not by how they look.
 *
 * `full_name` and `non_latin_name` decide from letter case and script, so a
 * name in capitals (`MOHAMMED AL MANSOURI` on an ID-card export), in lower case
 * (`sarah connor` in a log) or on its own (`Fatima`) is invisible to them. Yet
 * most personal data does not arrive as prose: it arrives as a CSV column, a
 * JSON field, a database row or a form line, and the structure says outright
 * which values are people. This module reads that structure:
 *
 *   {"full_name": "..."}  'customer': '...'     JSON, JS and Python objects
 *   Name: ...   first_name = "..."               labels, YAML, assignments
 *   full_name,dept / | Name | Email |            CSV, TSV, Markdown, and the
 *                                                spreadsheet reader's rows
 *
 * Keys are graded. A STRONG key (`full_name`, `surname`, `employee_name`,
 * `الاسم الكامل`) marks every name-shaped value as a person. A WEAK key (`name`,
 * `owner`, `customer`, `الاسم`) is also used for services, packages and
 * workflow steps, so its value must look like a person on its own: two or more
 * words, none of them ordinary vocabulary. A weak key whose values mostly pass
 * that test across a column or document is promoted to strong, which is how a
 * `Name` column still catches its single-word entries.
 *
 * A value is only ever a name if it is made of letters: anything with digits,
 * `@`, `/`, `_`, braces or similar is left to the patterns built for it.
 * Placeholders (`N/A`, `null`), organisations and places are rejected.
 *
 * Pure and synchronous: offsets are computed on the text it is given, so it
 * stays correct across the Guardian's chained masking passes.
 */

/** Keys that always hold a person's name. Compared after normalizeKey(). */
const STRONG_KEYS = new Set([
  'full_name', 'fullname', 'first_name', 'firstname', 'last_name', 'lastname',
  'given_name', 'givenname', 'family_name', 'familyname', 'surname', 'forename',
  'middle_name', 'maiden_name', 'legal_name', 'person_name', 'preferred_name',
  'account_holder', 'account_holder_name', 'cardholder', 'card_holder',
  'cardholder_name', 'card_holder_name', 'beneficiary', 'beneficiary_name',
  'next_of_kin', 'emergency_contact', 'emergency_contact_name', 'signatory',
  // Arabic, after normalizeKey() turns spaces into underscores
  'الاسم_الكامل', 'الاسم_الأول', 'الاسم_الاول', 'اسم_العائلة', 'اسم_الأب',
  'اسم_الاب', 'اسم_الأم', 'اسم_الام', 'اسم_الموظف', 'اسم_العميل', 'اسم_المريض',
  'اسم_المستفيد', 'اسم_صاحب_الحساب', 'اسم_حامل_البطاقة', 'اسم_المسافر',
]);

/** `<role>_name` is strong for these roles (`employee_name`, `patientName`). */
const ROLES = new Set([
  'employee', 'customer', 'client', 'patient', 'contact', 'owner', 'holder',
  'applicant', 'passenger', 'guest', 'member', 'student', 'parent', 'guardian',
  'spouse', 'father', 'mother', 'recipient', 'sender', 'driver', 'nominee',
  'tenant', 'landlord', 'buyer', 'seller', 'manager', 'supervisor', 'doctor',
  'physician', 'nurse', 'author', 'reviewer', 'approver', 'witness', 'sponsor',
  'visitor', 'candidate', 'borrower', 'insured', 'policyholder', 'subscriber',
  'traveler', 'traveller', 'representative', 'staff', 'teacher', 'child',
]);

/** Keys that often, but not always, hold a person's name. */
const WEAK_KEYS = new Set([
  'name', 'customer', 'client', 'employee', 'contact', 'owner', 'holder',
  'patient', 'passenger', 'guest', 'member', 'author', 'assignee', 'reporter',
  'manager', 'recipient', 'sender', 'applicant', 'tenant', 'driver', 'student',
  'display_name', 'displayname', 'contact_person', 'attn', 'attention',
  'signed_by', 'prepared_by', 'approved_by', 'reviewed_by', 'requested_by',
  'assigned_to', 'created_by', 'updated_by', 'modified_by', 'submitted_by',
  'الاسم', 'اسم', 'العميل', 'الموظف', 'المريض', 'المستفيد', 'المالك', 'مقدم_الطلب',
]);

/**
 * A key containing any of these tokens names a thing, not a person:
 * `company_name`, `file_name`, `host_name`, `اسم_الشركة`.
 */
const NOT_PERSON_TOKENS = new Set([
  'company', 'companies', 'org', 'organization', 'organisation', 'business',
  'product', 'file', 'filename', 'host', 'hostname', 'server', 'database', 'db',
  'table', 'column', 'schema', 'app', 'application', 'service', 'bucket',
  'branch', 'project', 'sheet', 'domain', 'device', 'brand', 'plan', 'model',
  'package', 'pkg', 'class', 'category', 'type', 'tag', 'label', 'key', 'field',
  'event', 'job', 'task', 'city', 'country', 'street', 'building', 'team',
  'department', 'dept', 'division', 'unit', 'bank', 'vendor', 'supplier',
  'merchant', 'store', 'shop', 'course', 'module', 'repo', 'repository',
  'image', 'container', 'cluster', 'region', 'zone', 'queue', 'topic', 'env',
  'environment', 'variable', 'font', 'color', 'colour', 'folder', 'dir',
  'directory', 'path', 'url', 'uri', 'link', 'site', 'website', 'page',
  'section', 'step', 'stage', 'workflow', 'pipeline', 'action', 'script',
  'function', 'method', 'test', 'metric', 'feature', 'flag', 'role', 'group',
  'channel', 'workspace', 'agent', 'bot', 'tool', 'report', 'document',
  'template', 'policy', 'rule', 'attribute', 'property', 'entity', 'resource',
  'الشركة', 'المنتج', 'الملف', 'المدينة', 'الدولة', 'القسم', 'الإدارة', 'الادارة',
  'البنك', 'الفرع', 'المشروع', 'الجهة', 'المؤسسة', 'الخدمة', 'التطبيق',
]);

/** Exact keys that hold logins or ids, not display names. */
const NOT_PERSON_KEYS = new Set(['username', 'user_name', 'login', 'userid', 'user_id', 'handle']);

/** Values that stand in for "no name". */
const PLACEHOLDERS = new Set([
  'n/a', 'na', 'none', 'null', 'nil', 'unknown', 'tbd', 'tba', 'undefined',
  'anonymous', 'redacted', 'test', 'user', 'admin', 'administrator', 'system',
  'root', 'guest', 'nobody', 'somebody', 'someone', 'everyone', 'all', 'self',
  'me', 'you', 'true', 'false', 'yes', 'no', 'غير معروف', 'لا يوجد', 'غير متوفر',
]);

/** Name particles never count as ordinary words when judging a value. */
const PARTICLES = new Set([
  'al', 'el', 'bin', 'bint', 'ibn', 'abu', 'bu', 'abd', 'abdul', 'de', 'dela',
  'del', 'da', 'di', 'dos', 'das', 'du', 'van', 'von', 'der', 'den', 'la', 'le',
  'ul', 'ud', 'bn', 'st',
  'بن', 'بنت', 'ابن', 'آل', 'عبد', 'أبو', 'ابو', 'أم', 'ام', 'بو',
]);

/**
 * A value made only of letters, marks, spaces, apostrophes, hyphens and dots,
 * with at most one comma for `Surname, Given` order.
 */
const NAME_SHAPE = /^[\p{L}\p{M}][\p{L}\p{M}'’. -]*(?:, ?[\p{L}\p{M}][\p{L}\p{M}'’. -]*)?$/u;

/** Case class of one word; Arabic and other caseless scripts return null. */
function caseOf(word) {
  const letters = word.replace(/[^\p{L}]/gu, '');
  if (!/[\p{Lu}\p{Ll}]/u.test(letters)) return null;
  if (letters === letters.toUpperCase()) return 'upper';
  if (letters === letters.toLowerCase()) return 'lower';
  if (/^\p{Lu}/u.test(letters)) return 'title'; // McDonald, O'Brien
  return 'mixed';
}

/**
 * `firstName` -> `first_name`, `Full Name` -> `full_name`, `"الاسم الكامل"` ->
 * `الاسم_الكامل`. Trailing language suffixes are dropped (`name_ar`).
 */
function normalizeKey(key) {
  return String(key)
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_(?:en|ar|eng|english|arabic)$/, '');
}

/**
 * @param {string} key
 * @returns {'strong'|'weak'|null}
 */
function classifyKey(key) {
  const n = normalizeKey(key);
  if (!n || n.length > 48) return null;
  if (NOT_PERSON_KEYS.has(n)) return null;
  if (STRONG_KEYS.has(n)) return 'strong';
  const tokens = n.split('_').filter(Boolean);
  if (tokens.some((t) => NOT_PERSON_TOKENS.has(t))) return null;
  // Compound keys: `emp_full_name`, `customer_first_name`, `billing_surname`.
  for (let i = 1; i < tokens.length; i++) {
    if (STRONG_KEYS.has(tokens.slice(i).join('_'))) return 'strong';
  }
  // `<role>_name`: `employee_name`, `patientName`, `contact_person_name`.
  const last = tokens[tokens.length - 1];
  const prev = tokens[tokens.length - 2];
  if (last === 'name' && prev && ROLES.has(prev)) return 'strong';
  if (WEAK_KEYS.has(n)) return 'weak';
  return null;
}

/**
 * Build the detector. Word lists and the org/place veto come from patterns.js
 * so the name gate and this module share one vocabulary.
 *
 * @param {object} deps
 * @param {Set<string>} deps.commonEn - ordinary English words (lower case)
 * @param {Set<string>} deps.commonAr - ordinary Arabic words
 * @param {function(string[]):boolean} deps.isOrgOrPlace - veto for places and organisations
 * @param {function(string[]):boolean} [deps.hasNameEvidence] - does any word
 *   appear in the name list? Required of values under weak keys when given.
 * @returns {function(string): Array<{start:number,end:number,original:string}>}
 */
function createPersonFieldDetector({ commonEn, commonAr, isOrgOrPlace, hasNameEvidence = null }) {
  const isCommon = (w) => {
    const lw = w.toLowerCase().replace(/[.'’]/g, '');
    return commonEn.has(lw) || commonAr.has(w);
  };

  /** Shape check shared by both grades. Returns the words, or null. */
  function nameWords(value) {
    if (!value || value.length > 80) return null;
    if (PLACEHOLDERS.has(value.toLowerCase())) return null;
    if (!NAME_SHAPE.test(value)) return null;
    const words = value.split(/[ ]+/).filter(Boolean);
    if (words.length === 0 || words.length > 6) return null;
    if (isOrgOrPlace(words)) return null;
    return words;
  }

  /**
   * A value under a weak key must look like a person without help: two or
   * more words, none of them ordinary vocabulary, written in one consistent
   * case, and -- with the name list -- at least one of them a listed name.
   * Names are `Ahmed Hassan`, `AHMED HASSAN` or `ahmed hassan`; a workflow
   * step is `Set up Node`; a product is `Wireless Mouse`.
   */
  function passesWeak(value) {
    const words = nameWords(value.replace(',', ''));
    if (!words || words.length < 2) return false;
    const content = words.filter((w) => !PARTICLES.has(w.toLowerCase()));
    if (content.length < 2) return false;
    if (!content.every((w) => !isCommon(w) && w.replace(/[.'’-]/g, '').length >= 2)) return false;
    const cases = new Set(content.map(caseOf).filter(Boolean));
    if (cases.size > 1 || cases.has('mixed')) return false;
    return !hasNameEvidence || hasNameEvidence(content);
  }

  return function detectPersonFields(text) {
    if (!text) return [];
    /** @type {Array<{key:string, grade:string, start:number, value:string}>} */
    const candidates = [];
    const push = (key, start, raw) => {
      const grade = classifyKey(key);
      if (!grade) return;
      // Trim, remembering how far the value moved, so the span stays exact.
      const lead = raw.length - raw.trimStart().length;
      const value = raw.trim();
      if (!value) return;
      candidates.push({ key: normalizeKey(key), grade, start: start + lead, value });
    };

    collectQuotedPairs(text, push);
    collectLabelLines(text, push);
    collectTables(text, push);

    // Promote a weak key when most of its values pass the weak test on their
    // own: a `Name` column of full names is a column of people, so its
    // single-word entries are people too. Demote it when most fail: in a CI
    // workflow, `name:` labels steps, and the odd step that happens to look
    // like a name (`Deploy Production`) is not a person either.
    const votes = new Map();
    for (const c of candidates) {
      if (c.grade !== 'weak') continue;
      const v = votes.get(c.key) || { pass: 0, total: 0 };
      v.total += 1;
      if (passesWeak(c.value)) v.pass += 1;
      votes.set(c.key, v);
    }
    const ratio = (key) => {
      const v = votes.get(key);
      return v && v.total >= 3 ? v.pass / v.total : null;
    };

    const out = [];
    const seen = new Set();
    for (const c of candidates) {
      let ok;
      if (c.grade === 'strong') {
        ok = Boolean(nameWords(c.value));
      } else {
        const r = ratio(c.key);
        if (r === null) ok = passesWeak(c.value);
        else if (r >= 0.6) ok = Boolean(nameWords(c.value));
        else if (r < 0.4) ok = false;
        else ok = passesWeak(c.value);
      }
      if (!ok || seen.has(c.start)) continue;
      seen.add(c.start);
      out.push({ start: c.start, end: c.start + c.value.length, original: c.value });
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Sources. Each calls push(key, absoluteOffsetOfRawValue, rawValue).
// ---------------------------------------------------------------------------

/** `"key": "value"` and `'key': 'value'` -- JSON, JS and Python objects. */
function collectQuotedPairs(text, push) {
  const rx = /(["'])([^"'\n]{1,48})\1[ \t]*[:=][ \t]*(["'])((?:(?!\3)[^\\\n]|\\.){0,120})\3/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const valueStart = m.index + m[0].length - 1 - m[4].length;
    push(m[2], valueStart, m[4]);
  }
}

/**
 * Line-level labels: `Name: value`, YAML `full_name: value`, `- owner: value`,
 * and assignments such as `customer_name = "value"` or
 * `const firstName = 'value'` (the last word before `=` is the key).
 */
function collectLabelLines(text, push) {
  const rx = /^[ \t]*(?:[-*•][ \t]+)?([\p{L}_][\p{L}\p{M}\p{N} _.$-]{0,48}?)[ \t]*([:：=])[ \t]*(.*)$/gmu;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const [line, rawKey, sep, rest] = m;
    if (!rest || /^[:=/]/.test(rest)) continue; // `::`, `==`, `://`
    let key = rawKey;
    if (sep === '=' && /\s/.test(rawKey.trim())) {
      key = rawKey.trim().split(/\s+/).pop(); // `const firstName`
    }
    const restStart = m.index + line.length - rest.length;
    const q = rest.match(/^(["'])(.*?)\1/);
    if (q) {
      push(key, restStart + 1, q[2]);
    } else if (!/^["']/.test(rest)) {
      // Unquoted: stop at the first delimiter a name never contains.
      const cut = rest.search(/[,;#|{}[\]<>()]/);
      push(key, restStart, cut === -1 ? rest : rest.slice(0, cut));
    }
  }
}

/**
 * Header-row tables: CSV, TSV, semicolon files, Markdown tables and the
 * spreadsheet reader's ` | `-joined rows. A block is a run of non-empty lines;
 * its first line is the header when most rows have the same field count.
 */
function collectTables(text, push) {
  const lines = [];
  let off = 0;
  for (const l of text.split('\n')) {
    lines.push({ text: l.replace(/\r$/, ''), start: off });
    off += l.length + 1;
  }
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].text.trim()) { i++; continue; }
    let j = i;
    while (j < lines.length && lines[j].text.trim()) j++;
    if (j - i >= 2) scanBlock(lines.slice(i, j), push);
    i = j;
  }
}

const DELIMITERS = ['\t', '|', ',', ';'];

function scanBlock(block, push) {
  for (const d of DELIMITERS) {
    if (!block[0].text.includes(d)) continue;
    // Markdown rows carry outer pipes that are not fields. Decided once per
    // block from the header, never per line: a spreadsheet row whose last cell
    // is empty also ends in `| ` and must keep that empty field.
    const markdown = d === '|' && /^\s*\|.*\|\s*$/.test(block[0].text);
    const header = splitFields(block[0].text, d, markdown);
    if (header.length < 2) continue;
    const rows = block.slice(1).filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l.text)); // Markdown `|---|`
    if (rows.length === 0) continue;
    const parsed = rows.map((l) => ({ line: l, fields: splitFields(l.text, d, markdown) }));
    const aligned = parsed.filter((p) => p.fields.length === header.length);
    if (aligned.length / parsed.length < 0.6) continue;

    const personCols = header
      .map((h, idx) => (classifyKey(h.value) ? idx : -1))
      .filter((idx) => idx >= 0);
    for (const p of aligned) {
      for (const idx of personCols) {
        const f = p.fields[idx];
        push(header[idx].value, p.line.start + f.start, f.value);
      }
    }
    return; // first delimiter that fits wins
  }
}

/**
 * Split one line into fields with offsets. Double-quoted CSV fields may hold the
 * delimiter; in a Markdown table the outer pipes are dropped. Offsets point at
 * the raw field, inside the quotes when quoted.
 */
function splitFields(line, d, markdown = false) {
  const fields = [];
  let start = 0;
  let k = 0;
  while (k <= line.length) {
    if (line[k] === '"' && (d === ',' || d === ';') && line.slice(start, k).trim() === '') {
      const close = line.indexOf('"', k + 1);
      if (close !== -1) {
        const after = line.indexOf(d, close);
        fields.push({ start: k + 1, value: line.slice(k + 1, close) });
        if (after === -1) { start = line.length + 1; break; }
        start = after + 1;
        k = start;
        continue;
      }
    }
    if (k === line.length || line[k] === d) {
      fields.push({ start, value: line.slice(start, k) });
      start = k + 1;
    }
    k++;
  }
  if (markdown && line.trimStart().startsWith('|')) fields.shift();
  if (markdown && line.trimEnd().endsWith('|')) fields.pop();
  return fields;
}

module.exports = { createPersonFieldDetector, classifyKey, normalizeKey, splitFields };
