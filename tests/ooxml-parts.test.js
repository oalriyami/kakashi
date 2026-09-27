const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const JSZip = require('jszip');
const XLSX = require('xlsx');

const formats = require('../src/engine/formats');
const { maskText } = require('../src/engine/masker');
const ooxml = require('../src/engine/formats/ooxml');
const pkg = require('../src/engine/formats/package');

const CLI = path.join(__dirname, '..', 'bin', 'kakashi.js');

// ---------------------------------------------------------------------------
// Two things are under test here, both about WHERE text lives in an Office
// package rather than what it says.
//
//   #28  Line breaks, tabs and non-breaking hyphens are elements, not text.
//        Skipping them fused a signature block into one line, so values next
//        to a break were never detected.
//   #27  Footnotes, comments, masters, charts, properties, link targets and
//        embedded files were never read, so `scan` said 0 findings and Guardian
//        released the original file.
//
// Packages are built in the test so the XML under test is visible here. All
// values are synthetic: example.org addresses, the documentation card number,
// an Emirates ID with a valid check digit that belongs to nobody.
// ---------------------------------------------------------------------------

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const CT = 'application/vnd.openxmlformats-officedocument';

/** Write a package from `{ partName: xml }` and a list of content-type overrides. */
async function makePackage(dir, name, parts, overrides = {}) {
  const zip = new JSZip();
  const ov = Object.entries(overrides)
    .map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join('');
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + `<Default Extension="xml" ContentType="application/xml"/>${ov}</Types>`);
  for (const [part, content] of Object.entries(parts)) zip.file(part, content);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

const docxBody = (inner) => `<?xml version="1.0"?><w:document ${W}><w:body>${inner}</w:body></w:document>`;
const para = (inner) => `<w:p>${inner}</w:p>`;
const run = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const sld = (tag, inner) => `<?xml version="1.0"?><p:${tag} ${P} ${A}><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:${tag}>`;
const shape = (paras, ph = '') => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="TextBox 1"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>`
  + `<p:txBody>${paras.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;

/** Every part of a package (recursing into embedded packages), entities decoded. */
async function allParts(file) {
  const out = {};
  async function walk(buf, prefix) {
    const zip = await JSZip.loadAsync(buf);
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const data = await entry.async('nodebuffer');
      if (data[0] === 0x50 && data[1] === 0x4b) {
        await walk(data, `${prefix}${name}!/`);
        continue;
      }
      out[prefix + name] = ooxml.decodeXml(data.toString('utf8'));
    }
  }
  await walk(fs.readFileSync(file), '');
  return out;
}

/** Parts that still contain any of `needles`. */
async function leaks(file, needles) {
  const parts = await allParts(file);
  const hits = [];
  for (const [name, text] of Object.entries(parts)) {
    for (const n of needles) if (text.includes(n)) hits.push(`${name}: ${n}`);
  }
  return hits;
}

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

async function runOoxmlPartsTests() {
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakashi-parts-'));

  // =========================================================================
  // #28 -- breaks, tabs and hyphens are read-only characters.
  // =========================================================================

  // A signature block the way Word stores it: one paragraph, soft line breaks
  // between the lines, a tab between a label and its value.
  const SIGNATURE = para(
    '<w:pPr><w:tabs><w:tab w:val="left" w:pos="1440"/></w:tabs></w:pPr>'
    + '<w:r><w:t>Rajesh Kumar</w:t><w:br/><w:t>Mobile: +971 50 123 4567</w:t><w:br/>'
    + '<w:t>Card 4111 1111 1111 1111</w:t><w:tab/><w:t>Email</w:t><w:tab/><w:t>r.kumar@example.org</w:t></w:r>',
  );

  await check('#28 docx: a soft break and a tab separate the text they sit between', async () => {
    const f = await makePackage(dir, 'sig.docx', { 'word/document.xml': docxBody(SIGNATURE) });
    const { text } = await formats.readFile(f);
    assert.strictEqual(text,
      'Rajesh Kumar\nMobile: +971 50 123 4567\nCard 4111 1111 1111 1111\tEmail\tr.kumar@example.org');
  });

  await check('#28 docx: a tab STOP definition is not a tab character', () => {
    const xml = para('<w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>' + run('a b'));
    assert.strictEqual(ooxml.extractText(xml, ooxml.WORD), 'a b');
  });

  await check('#28 docx: every value in the signature is masked and the labels survive', async () => {
    const f = await makePackage(dir, 'sig2.docx', { 'word/document.xml': docxBody(SIGNATURE) });
    const out = path.join(dir, 'sig2-out.docx');
    const r = cli(['mask', f, '-o', out]);
    assert.strictEqual(r.status, 0, r.stderr);
    const xml = (await allParts(out))['word/document.xml'];
    for (const v of ['Rajesh Kumar', '+971 50 123 4567', '4111', 'r.kumar@example.org']) {
      assert.ok(!xml.includes(v), `${v} survived`);
    }
    assert.ok(xml.includes('>Email<'), 'the Email label was swallowed by a token');
    assert.strictEqual((xml.match(/<w:br\/>/g) || []).length, 2, 'line breaks lost');
    assert.strictEqual((xml.match(/<w:tab\/>/g) || []).length, 2, 'tabs lost');
    assert.ok(xml.includes('w:pos="1440"'), 'tab stop definition changed');
  });

  await check('#28 pptx: <a:br> separates lines on a slide', async () => {
    const slide = sld('sld', '<p:sp><p:txBody><a:p><a:r><a:t>Rajesh Kumar</a:t></a:r><a:br><a:rPr lang="en-US"/></a:br>'
      + '<a:r><a:t>Mobile: +971 50 123 4567</a:t></a:r></a:p></p:txBody></p:sp>');
    const f = await makePackage(dir, 'sig.pptx', { 'ppt/slides/slide1.xml': slide });
    const { text } = await formats.readFile(f);
    assert.strictEqual(text, 'Rajesh Kumar\nMobile: +971 50 123 4567');
    const out = path.join(dir, 'sig-out.pptx');
    assert.strictEqual(cli(['mask', f, '-o', out]).status, 0);
    const xml = (await allParts(out))['ppt/slides/slide1.xml'];
    assert.ok(!xml.includes('+971 50 123 4567') && !xml.includes('Rajesh Kumar'), 'value next to a break survived');
    assert.ok(xml.includes('<a:br>'), 'break lost');
  });

  await check('#28 docx: a non-breaking hyphen is part of the value it sits in', async () => {
    const eid = '<w:r><w:t>Emirates ID 784</w:t><w:noBreakHyphen/><w:t>1990</w:t><w:noBreakHyphen/>'
      + '<w:t>1234567</w:t><w:noBreakHyphen/><w:t>4</w:t></w:r>';
    const f = await makePackage(dir, 'nbh.docx', { 'word/document.xml': docxBody(para(eid)) });
    const { text } = await formats.readFile(f);
    assert.ok(text.includes('784-1990-1234567-4'), text);
    const out = path.join(dir, 'nbh-out.docx');
    assert.strictEqual(cli(['mask', f, '-o', out]).status, 0);
    const xml = (await allParts(out))['word/document.xml'];
    assert.ok(!xml.includes('1234567'), 'ID digits survived');
  });

  await check('#28 docx: deleted and inserted text do not fuse; deleted text is masked', async () => {
    const tracked = para(run('Call ')
      + '<w:del w:id="1" w:author="Reviewer"><w:r><w:delText>d.old@example.org</w:delText></w:r></w:del>'
      + '<w:ins w:id="2" w:author="Reviewer"><w:r><w:t>today</w:t></w:r></w:ins>');
    const xml = docxBody(tracked);
    assert.strictEqual(ooxml.extractText(xml, ooxml.WORD), 'Call \nd.old@example.org\ntoday');
    const out = ooxml.maskXml(xml, { 'd.old@example.org': '[EMAIL_1]' }, ooxml.WORD);
    assert.ok(out.includes('<w:delText>[EMAIL_1]</w:delText>'), out);
  });

  await check('#28 docx: a text box does not steal the rest of its outer paragraph', () => {
    const xml = para(run('Contact s.')
      + '<w:r><w:pict><w:txbxContent>' + para(run('Box text')) + '</w:txbxContent></w:pict></w:r>'
      + run('hassan@example.org'));
    assert.strictEqual(ooxml.extractText(xml, ooxml.WORD), 'Contact s.hassan@example.org\nBox text');
  });

  // =========================================================================
  // #27 -- every part that carries text is read, masked and verified.
  // =========================================================================

  const DOCX_HIDDEN = {
    'word/document.xml': docxBody(para(run('Quarterly summary, see note'))
      + para('<w:fldSimple w:instr=" HYPERLINK &quot;mailto:field.simple@example.org&quot; "><w:r><w:t>write to us</w:t></w:r></w:fldSimple>')
      + para('<w:r><w:instrText xml:space="preserve"> HYPERLINK "mailto:instr.text@example.org" </w:instrText></w:r>'
        + '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>mail</w:t></w:r>')
      + para('<w:r><w:drawing><wp:inline xmlns:wp="x"><wp:docPr id="1" name="Picture 1" descr="Scan of card 4111 1111 1111 1111"/></wp:inline></w:drawing></w:r>')
      + para('<w:hyperlink r:id="rId9" xmlns:r="r">' + run('our site') + '</w:hyperlink>')),
    'word/footnotes.xml': `<?xml version="1.0"?><w:footnotes ${W}><w:footnote w:id="1">${para(run('Emirates ID 784-1990-1234567-4, AWS key AKIAQ3EGUXYZ7ABCD123'))}</w:footnote></w:footnotes>`,
    'word/endnotes.xml': `<?xml version="1.0"?><w:endnotes ${W}><w:endnote w:id="1">${para(run('Contact end.note@example.org'))}</w:endnote></w:endnotes>`,
    'word/comments.xml': `<?xml version="1.0"?><w:comments ${W}><w:comment w:id="0" w:author="comment.author@example.org" w:initials="CA">${para(run('ok'))}</w:comment></w:comments>`,
    'word/people.xml': '<?xml version="1.0"?><w15:people xmlns:w15="x"><w15:person w15:author="Reviewer"><w15:presenceInfo w15:providerId="AD" w15:userId="people.user@example.org"/></w15:person></w15:people>',
    'word/_rels/document.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId9" Type="hyperlink" Target="mailto:link.target@example.org" TargetMode="External"/>'
      + '<Relationship Id="rId1" Type="styles" Target="styles.xml"/></Relationships>',
    'docProps/core.xml': '<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y" xmlns:dcterms="z">'
      + '<dc:creator>core.creator@example.org</dc:creator><cp:lastModifiedBy>Editor</cp:lastModifiedBy>'
      + '<dcterms:created>2026-09-27T05:00:00Z</dcterms:created></cp:coreProperties>',
    'docProps/custom.xml': '<?xml version="1.0"?><Properties xmlns:vt="v">'
      + '<property fmtid="{D5CDD505}" pid="2" name="Owner"><vt:lpwstr>custom.owner@example.org</vt:lpwstr></property>'
      + '<property fmtid="{D5CDD505}" pid="3" name="ContentTypeId"><vt:lpwstr>0x0101002D6C1B8F5DA3CE4A8A5A1F1A7B0C2E1F9A8B</vt:lpwstr></property></Properties>',
    'customXml/item1.xml': '<?xml version="1.0"?><CoverPageProperties><CompanyEmail>custom.xml@example.org</CompanyEmail></CoverPageProperties>',
  };
  const DOCX_HIDDEN_VALUES = ['field.simple@example.org', 'instr.text@example.org', '4111 1111 1111 1111',
    '784-1990-1234567-4', 'AKIAQ3EGUXYZ7ABCD123', 'end.note@example.org', 'comment.author@example.org',
    'people.user@example.org', 'link.target@example.org', 'core.creator@example.org',
    'custom.owner@example.org', 'custom.xml@example.org'];

  await check('#27 docx: footnotes, fields, alt text, authors, properties and link targets are read', async () => {
    const f = await makePackage(dir, 'hidden.docx', DOCX_HIDDEN);
    const { text } = await formats.readFile(f);
    const found = maskText(text).findings.map((x) => x.original);
    for (const v of DOCX_HIDDEN_VALUES) assert.ok(found.includes(v), `${v} not detected`);
  });

  await check('#27 docx: SharePoint ContentTypeId is not read as a secret', async () => {
    const f = await makePackage(dir, 'ctid.docx', {
      'word/document.xml': docxBody(para(run('Plain text'))),
      'docProps/custom.xml': DOCX_HIDDEN['docProps/custom.xml'].replace(/<property[^]*?name="Owner">[^]*?<\/property>/, ''),
    });
    const { text } = await formats.readFile(f);
    assert.deepStrictEqual(maskText(text).findings.map((x) => x.id), []);
  });

  await check('#27 docx: mask removes every hidden value and keeps the timestamp valid', async () => {
    const f = await makePackage(dir, 'hidden2.docx', DOCX_HIDDEN);
    const out = path.join(dir, 'hidden2-out.docx');
    const r = cli(['mask', f, '-o', out]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(await leaks(out, DOCX_HIDDEN_VALUES), []);
    const parts = await allParts(out);
    assert.ok(parts['docProps/core.xml'].includes('<dcterms:created>2026-09-27T05:00:00Z</dcterms:created>'));
    assert.ok(parts['word/_rels/document.xml.rels'].includes('Target="styles.xml"'), 'internal relationship rewritten');
  });

  await check('#27 guard: a docx with a secret only in a footnote is not released as-is', async () => {
    const f = await makePackage(dir, 'foot.docx', {
      'word/document.xml': docxBody(para(run('Quarterly summary'))),
      'word/footnotes.xml': DOCX_HIDDEN['word/footnotes.xml'],
    });
    const out = path.join(dir, 'guarded_foot.docx');
    const r = cli(['guard', f, '-d', 'external_model', '--approve', 'CREDENTIAL', '-o', out, '--no-audit', '--json']);
    const decision = JSON.parse(r.stdout);
    assert.notStrictEqual(decision.decision, 'ALLOW', 'Guardian released the original');
    if (decision.decision === 'ALLOW_WITH_TRANSFORMATION') {
      assert.deepStrictEqual(await leaks(out, ['784-1990-1234567-4', 'AKIAQ3EGUXYZ7ABCD123']), []);
    }
  });

  await check('#27 docx: a part named off-convention is found through its content type', async () => {
    const f = await makePackage(dir, 'ctype.docx', {
      'word/document.xml': docxBody(para(run('Body'))),
      'word/notes/fn1.xml': `<?xml version="1.0"?><w:footnotes ${W}><w:footnote w:id="1">${para(run('odd.name@example.org'))}</w:footnote></w:footnotes>`,
    }, { 'word/notes/fn1.xml': `${CT}.wordprocessingml.footnotes+xml` });
    const { text } = await formats.readFile(f);
    assert.ok(text.includes('odd.name@example.org'), text);
  });

  await check('#27 pptx: masters, layouts, charts, comments and authors are read and masked', async () => {
    const parts = {
      'ppt/slides/slide1.xml': sld('sld', shape(['Agenda'])),
      'ppt/slideMasters/slideMaster1.xml': sld('sldMaster',
        shape(['Click to edit Master title style'], '<p:ph type="title"/>')
        + shape(['Edit Master text styles', 'Second level'], '<p:ph type="body" idx="1"/>')
        + shape(['Confidential - master.footer@example.org'], '<p:ph type="ftr" idx="11"/>')
        + shape(['Prepared by layout.box@example.org'])),
      'ppt/slideLayouts/slideLayout1.xml': sld('sldLayout', shape(['Second Outline Level', 'Third Outline Level'], '<p:ph idx="1"/>')),
      'ppt/charts/chart1.xml': '<?xml version="1.0"?><c:chartSpace xmlns:c="c"><c:strCache><c:pt idx="0"><c:v>chart.point@example.org</c:v></c:pt></c:strCache></c:chartSpace>',
      'ppt/comments/comment1.xml': `<?xml version="1.0"?><p:cmLst ${P}><p:cm authorId="0"><p:text>Ping legacy.comment@example.org</p:text></p:cm></p:cmLst>`,
      'ppt/commentAuthors.xml': `<?xml version="1.0"?><p:cmAuthorLst ${P}><p:cmAuthor id="0" name="author.name@example.org" initials="AN"/></p:cmAuthorLst>`,
    };
    const f = await makePackage(dir, 'deck.pptx', parts);
    const { text } = await formats.readFile(f);
    const found = maskText(text).findings.map((x) => x.original);
    const values = ['master.footer@example.org', 'layout.box@example.org', 'chart.point@example.org',
      'legacy.comment@example.org', 'author.name@example.org'];
    for (const v of values) assert.ok(found.includes(v), `${v} not detected`);
    // Prompt text in content placeholders never renders, and read as prose it
    // is Title Case noise on every deck.
    assert.ok(!text.includes('Edit Master') && !text.includes('Outline Level'), 'placeholder prompts were read');

    const out = path.join(dir, 'deck-out.pptx');
    assert.strictEqual(cli(['mask', f, '-o', out]).status, 0);
    assert.deepStrictEqual(await leaks(out, values), []);
  });

  await check('#27 xlsx: comments, link targets, sheet names, properties and defined names', async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['Name', 'Note'], ['Row', 'see comment']]);
    ws.B2.c = [{ a: 'comment.author@example.org', t: 'Verify comment.body@example.org' }];
    ws.A2.l = { Target: 'mailto:cell.link@example.org' };
    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'sheet.name@example.org');
    ws.C2 = { t: 'n', f: "'sheet.name@example.org'!A1&\" formula.literal@example.org\"", v: 0 };
    ws['!ref'] = 'A1:C2';
    wb.Props = { Author: 'props.author@example.org', Title: 'Payroll' };
    wb.Workbook = { Names: [{ Name: 'Owner', Ref: '"defined.name@example.org"' }] };
    const f = path.join(dir, 'book.xlsx');
    XLSX.writeFile(wb, f);

    const values = ['comment.author@example.org', 'comment.body@example.org', 'cell.link@example.org',
      'sheet.name@example.org', 'formula.literal@example.org', 'props.author@example.org', 'defined.name@example.org'];
    const { text } = await formats.readFile(f);
    const found = maskText(text).findings.map((x) => x.original);
    for (const v of values) assert.ok(found.includes(v), `${v} not detected`);

    const out = path.join(dir, 'book-out.xlsx');
    const r = cli(['mask', f, '-o', out]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(await leaks(out, values), []);

    // The sheet was renamed to a LEGAL name and the formula follows it.
    const back = XLSX.readFile(out);
    const renamed = back.SheetNames[1];
    assert.ok(!/[[\]:*?/\\]/.test(renamed) && renamed.length <= 31, `illegal sheet name ${renamed}`);
    assert.ok(back.Sheets.Data.C2.f.startsWith(`${renamed}!A1`) || back.Sheets.Data.C2.f.startsWith(`'${renamed}'!A1`),
      `formula not retargeted: ${back.Sheets.Data.C2.f}`);
  });

  await check('#27 pptx: an embedded workbook is masked recursively', async () => {
    const inner = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(inner, XLSX.utils.aoa_to_sheet([['Series'], ['embedded.cell@example.org']]), 'Sheet1');
    const innerBuf = XLSX.write(inner, { type: 'buffer', bookType: 'xlsx' });
    const f = await makePackage(dir, 'embed.pptx', {
      'ppt/slides/slide1.xml': sld('sld', shape(['Chart'])),
      'ppt/embeddings/Microsoft_Excel_Worksheet.xlsx': innerBuf,
    });
    const { text } = await formats.readFile(f);
    assert.ok(text.includes('embedded.cell@example.org'), 'embedded workbook not read');
    const out = path.join(dir, 'embed-out.pptx');
    assert.strictEqual(cli(['mask', f, '-o', out]).status, 0);
    assert.deepStrictEqual(await leaks(out, ['embedded.cell@example.org']), []);
  });

  await check('#27 mask: the first-page thumbnail is removed with its references', async () => {
    const f = await makePackage(dir, 'thumb.docx', {
      'word/document.xml': docxBody(para(run('Mail thumb@example.org'))),
      'docProps/thumbnail.jpeg': Buffer.from('not really a jpeg'),
      '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="officeDocument" Target="word/document.xml"/>'
        + '<Relationship Id="rId2" Type="thumbnail" Target="docProps/thumbnail.jpeg"/></Relationships>',
    }, { 'docProps/thumbnail.jpeg': 'image/jpeg' });
    const out = path.join(dir, 'thumb-out.docx');
    assert.strictEqual(cli(['mask', f, '-o', out]).status, 0);
    const parts = await allParts(out);
    assert.ok(!parts['docProps/thumbnail.jpeg'], 'thumbnail kept');
    assert.ok(!parts['_rels/.rels'].includes('thumbnail'), 'dangling thumbnail relationship');
    assert.ok(!parts['[Content_Types].xml'].includes('thumbnail'), 'dangling content type');
    assert.ok(parts['_rels/.rels'].includes('word/document.xml'), 'main relationship removed');
  });

  // --- Verification: nothing is written when a value survives ---------------

  await check('#27 mask: a value the writer cannot reach fails closed and writes nothing', async () => {
    // A key that starts in the body and ends in a footnote is found in the
    // joined text but lives in no single part the writer can rewrite.
    const f = await makePackage(dir, 'split-parts.docx', {
      'word/document.xml': docxBody(para(run('-----BEGIN RSA PRIVATE KEY-----'))
        + para(run('MIIEowIBAAKCAQEA7bq1vKmCnRZ6YJbWkKq3ERVtVQwIIGZ9yDbXwv0T0vD0xg'))),
      'word/footnotes.xml': `<?xml version="1.0"?><w:footnotes ${W}><w:footnote w:id="1">${para(run('-----END RSA PRIVATE KEY-----'))}</w:footnote></w:footnotes>`,
    });
    const { text } = await formats.readFile(f);
    assert.ok(maskText(text).findings.some((x) => x.id === 'ssh_key'), 'test premise: key found across parts');
    const out = path.join(dir, 'split-parts-out.docx');
    const r = cli(['mask', f, '-o', out]);
    assert.strictEqual(r.status, 2, `expected exit 2, got ${r.status}: ${r.stdout}`);
    assert.ok(/still contains/.test(r.stderr), r.stderr);
    assert.ok(!fs.existsSync(out), 'a partially masked file was written');
  });

  // =========================================================================
  // #29 -- a value that spans paragraphs is masked, not reported and left.
  // =========================================================================

  const PEM_LINES = ['-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEA7bq1vKmCnRZ6YJbWkKq3ERVtVQwIIGZ9yDbXwv0T0vD0xg',
    'q3ERVtVQwIIGZ9yDbXwv0T0vD0xgMIIEowIBAAKCAQEA7bq1vKmCnRZ6YJbWkK',
    '-----END RSA PRIVATE KEY-----'];

  await check('#29 docx: a private key pasted one line per paragraph is removed', async () => {
    const body = para(run('Deploy key:')) + PEM_LINES.map((l) => para(run(l))).join('')
      + '<w:p/>' + para(run('Rotate quarterly.'));
    const f = await makePackage(dir, 'pem.docx', { 'word/document.xml': docxBody(body) });
    const out = path.join(dir, 'pem-out.docx');
    const r = cli(['mask', f, '-o', out]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(await leaks(out, ['BEGIN RSA', 'MIIEowIBAAK', 'q3ERVtVQ', 'END RSA']), []);
    const { text } = await formats.readFile(out);
    assert.strictEqual(text, 'Deploy key:\n[SSH_KEY_1]\nRotate quarterly.');
  });

  await check('#29 docx: blank paragraphs inside the value do not stop the match', async () => {
    const body = PEM_LINES.map((l) => para(run(l))).join(para(run('  ')));
    const f = await makePackage(dir, 'pem-gaps.docx', { 'word/document.xml': docxBody(body) });
    const out = path.join(dir, 'pem-gaps-out.docx');
    assert.strictEqual(cli(['mask', f, '-o', out]).status, 0);
    assert.deepStrictEqual(await leaks(out, ['MIIEowIBAAK', 'END RSA']), []);
  });

  await check('#29 pptx: a value split across paragraphs of one text box is removed', async () => {
    const f = await makePackage(dir, 'pem.pptx', { 'ppt/slides/slide1.xml': sld('sld', shape(PEM_LINES)) });
    const out = path.join(dir, 'pem-out.pptx');
    assert.strictEqual(cli(['mask', f, '-o', out]).status, 0);
    assert.deepStrictEqual(await leaks(out, ['MIIEowIBAAK', 'END RSA']), []);
  });

  await check('#29 ooxml: masking a large part stays linear', () => {
    // 20,000 paragraphs with an email in every one: 20,000 spans over one part.
    const xml = docxBody(Array.from({ length: 20000 }, (_, i) => para(run(`row ${i} u${i}@example.org`))).join(''));
    const map = {};
    for (let i = 0; i < 20000; i++) map[`u${i}@example.org`] = `[EMAIL_${i + 1}]`;
    const t0 = Date.now();
    const out = ooxml.maskXml(xml, map, ooxml.WORD);
    const ms = Date.now() - t0;
    assert.ok(!out.includes('@example.org'), 'an address survived');
    assert.ok(ms < 5000, `took ${ms} ms`);
  });

  await check('#27 verify: a name that also appears in the theme does not block the write', async () => {
    // Names are only checked where text lives; "Calibri Light" in a theme or a
    // timestamp in docProps is structure, not a leak.
    const f = await makePackage(dir, 'theme.docx', {
      'word/document.xml': docxBody(para(run('Signed by Rajesh Kumar'))),
      'word/theme/theme1.xml': '<?xml version="1.0"?><a:theme xmlns:a="a" name="Rajesh Kumar"><a:latin typeface="Rajesh Kumar"/></a:theme>',
    });
    const out = path.join(dir, 'theme-out.docx');
    const r = cli(['mask', f, '-o', out]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!(await allParts(out))['word/document.xml'].includes('Rajesh Kumar'));
  });

  await check('#27 verify: a strong value outside the coverage table is caught', async () => {
    const zip = new JSZip();
    zip.file('word/unknown.xml', '<x>key AKIAQ3EGUXYZ7ABCD123</x>');
    const survivors = await pkg.findSurvivors(zip, 'docx', { AKIAQ3EGUXYZ7ABCD123: '[AWS_KEY_1]' });
    assert.deepStrictEqual(survivors, [{ part: 'word/unknown.xml', count: 1 }]);
  });

  // --- Content Kakashi cannot read ------------------------------------------

  await check('#27 guard: an embedded OLE object needs approval before an external release', async () => {
    const f = await makePackage(dir, 'ole.docx', {
      'word/document.xml': docxBody(para(run('Nothing sensitive here'))),
      'word/embeddings/oleObject1.bin': Buffer.from('opaque OLE payload'),
    });
    const scan = cli(['scan', f]);
    assert.ok(/could not be read/.test(scan.stdout), scan.stdout);

    const ext = cli(['guard', f, '-d', 'external_model', '--no-audit', '--json']);
    assert.strictEqual(ext.status, 3, ext.stdout);
    const d = JSON.parse(ext.stdout);
    assert.strictEqual(d.reasonCode, 'UNSCANNED_CONTENT');
    assert.deepStrictEqual(d.approvalsNeeded, ['UNSCANNED_CONTENT']);
    assert.strictEqual(d.unscannedParts, 1);

    const approved = cli(['guard', f, '-d', 'external_model', '--approve', 'UNSCANNED_CONTENT', '--no-audit', '--json']);
    assert.strictEqual(JSON.parse(approved.stdout).decision, 'ALLOW');

    const local = cli(['guard', f, '-d', 'local', '--no-audit', '--json']);
    assert.strictEqual(JSON.parse(local.stdout).decision, 'ALLOW');
  });

  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`ooxml-parts.test.js: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

module.exports = { runOoxmlPartsTests };

if (require.main === module) {
  runOoxmlPartsTests().then((ok) => process.exit(ok ? 0 : 1));
}
