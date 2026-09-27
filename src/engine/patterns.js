const { createPersonFieldDetector } = require('./person-fields');
const { createNameSpanDetectors } = require('./name-spans');
const { isKnownName, isAmbiguousName, isGivenName } = require('./names');

const NAME_STOPLIST = new Set([
  'the', 'of', 'in', 'for', 'a', 'an', 'and', 'or', 'to', 'from', 'with',
  'by', 'at', 'on', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
  'ought', 'used', 'not', 'no', 'nor', 'but', 'if', 'then', 'else',
  'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few',
  'more', 'most', 'other', 'some', 'such', 'than', 'too', 'very', 'just',
  'don', 'now', 'only', 'own', 'same', 'so', 'also', 'as', 'it', 'its',
  'this', 'that', 'these', 'those', 'he', 'she', 'they', 'we', 'you',
  'his', 'her', 'their', 'our', 'your', 'my', 'me', 'him', 'them', 'us',
  'who', 'whom', 'which', 'what', 'whose', 'new', 'old', 'first', 'last',
  'next', 'previous', 'total', 'sum', 'count', 'value', 'data', 'report',
  'table', 'column', 'row', 'field', 'name', 'type', 'date', 'time',
  'year', 'month', 'day', 'number', 'id', 'code', 'status', 'state',
]);

// ---------------------------------------------------------------------------
// Precision gating for the two name patterns.
//
// `full_name` matches any run of capitalised words and `non_latin_name` any run
// of Arabic words. Both are necessarily broad -- a name is just words -- and on
// ordinary prose that broadness dominates: scanning Kakashi's own source used to
// report 36 "full names" (`Core Rule`, `Total Findings`, `Database Connection`)
// and 48 "Arabic names", where the Arabic hits were the report vocabulary
// itself (`تقرير امتثال` is "compliance report"). For a tool whose Guardian has
// an explicit `preserveTaskUtility` goal, masking a heading is not harmless: it
// destroys the context the requesting agent needs.
//
// The gate is deliberately asymmetric, because the two errors are not
// comparable. Missing a real name is a disclosure; masking a heading is an
// annoyance. So a match is rejected ONLY when EVERY token is an ordinary word
// of the language. One unrecognised token -- which is what a real name almost
// always contributes -- is enough to keep the match. `Ahmed Hassan`, `محمد
// أحمد` and even `Contact Ahmed Hassan` all survive; `Core Rule` and `تقرير
// امتثال` do not.
//
// A name built entirely from ordinary words (`Mark Price`, `اسم الله`) would
// still be dropped by that rule alone, so an explicit cue immediately before
// the match -- a title, or a labelled field -- overrides it and forces the
// match to be kept.
// ---------------------------------------------------------------------------

/** Ordinary English words that appear capitalised in headings, labels and docs. */
const COMMON_EN = new Set([
  ...NAME_STOPLIST,
  // Document and report vocabulary
  'core', 'rule', 'rules', 'summary', 'overview', 'introduction', 'section',
  'chapter', 'appendix', 'figure', 'note', 'notes', 'warning', 'caution',
  'example', 'examples', 'reference', 'references', 'index', 'contents',
  'title', 'subtitle', 'header', 'footer', 'page', 'pages', 'version',
  'draft', 'final', 'review', 'approved', 'rejected', 'pending', 'complete',
  'findings', 'finding', 'result', 'results', 'summary', 'details', 'detail',
  'description', 'purpose', 'scope', 'background', 'method', 'methods',
  'conclusion', 'recommendation', 'recommendations', 'action', 'actions',
  // Technical vocabulary
  'database', 'connection', 'server', 'client', 'service', 'services',
  'request', 'response', 'error', 'errors', 'warning', 'debug', 'info',
  'config', 'configuration', 'setting', 'settings', 'option', 'options',
  'default', 'custom', 'user', 'users', 'admin', 'account', 'accounts',
  'file', 'files', 'folder', 'directory', 'path', 'paths', 'output', 'input',
  'source', 'target', 'format', 'formats', 'pattern', 'patterns', 'match',
  'key', 'keys', 'token', 'tokens', 'secret', 'secrets', 'password',
  'credential', 'credentials', 'access', 'permission', 'permissions',
  'security', 'privacy', 'policy', 'policies', 'compliance', 'audit',
  'scan', 'mask', 'masked', 'redact', 'redacted', 'protected', 'personal',
  'sensitive', 'private', 'public', 'local', 'remote', 'external', 'internal',
  'test', 'tests', 'testing', 'sample', 'demo', 'mock', 'fixture',
  'install', 'setup', 'usage', 'command', 'commands', 'flag', 'flags',
  'category', 'categories', 'severity', 'level', 'levels', 'priority',
  // Business vocabulary
  'company', 'business', 'customer', 'customers', 'client', 'clients',
  'employee', 'employees', 'staff', 'department', 'team', 'manager',
  'contact', 'address', 'phone', 'email', 'mobile', 'office', 'branch',
  'invoice', 'payment', 'amount', 'balance', 'currency', 'price', 'cost',
  'quarter', 'quarterly', 'annual', 'monthly', 'weekly', 'daily',
  'project', 'projects', 'product', 'products', 'platform', 'system',
  // Calendar words that are capitalised in prose
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  // Data-protection vocabulary. This is the register Kakashi's own documents,
  // reports and policy names are written in, so without these every heading in
  // a compliance document reads as a person ("Data Protection Officer").
  'protection', 'processing', 'processor', 'controller', 'subject', 'subjects',
  'breach', 'breaches', 'consent', 'lawful', 'basis', 'rights', 'obligations',
  'notification', 'reporting', 'transfer', 'cross', 'border', 'retention',
  'definitions', 'conditions', 'requirements', 'guidance', 'standard',
  'standards', 'regulation', 'regulations', 'law', 'laws', 'article',
  'articles', 'decree', 'federal', 'clause', 'terms', 'agreement',
  'officer', 'authority', 'governance', 'framework', 'control', 'controls',
  'risk', 'risks', 'assessment', 'impact', 'measure', 'measures',
  'identifier', 'identifiers', 'record', 'records', 'entry', 'entries',
  'guardian', 'engine', 'module', 'library', 'package', 'release', 'changelog',
  'ordinary', 'english', 'arabic', 'visa', 'passport', 'licence', 'license',
  'national', 'unified', 'bank', 'card', 'credit', 'number', 'numbers',
  // Form and HR column headers. `Full Name`, `Place Of Birth` and `Passport
  // Expiry` label a column of people; they are not people themselves.
  'full', 'given', 'middle', 'surname', 'forename', 'maiden', 'legal', 'holder',
  'cardholder', 'beneficiary', 'applicant', 'passenger', 'nationality', 'gender',
  'birth', 'place', 'expiry', 'issue', 'issued', 'marital', 'religion',
  'occupation', 'employer', 'designation', 'salary', 'joining', 'relationship',
  'emergency', 'residence', 'residency', 'emirate', 'sponsor', 'remarks',
  'comments', 'signature',
]);

/**
 * Ordinary Arabic words: function words plus the report/compliance vocabulary
 * this tool's own output is written in.
 */
const COMMON_AR = new Set([
  // Function words and particles
  'من', 'في', 'على', 'إلى', 'الى', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'تلك',
  'التي', 'الذي', 'الذين', 'كل', 'بعض', 'غير', 'قد', 'لا', 'ما', 'أو', 'او',
  'ثم', 'لكن', 'أن', 'ان', 'إن', 'كان', 'كانت', 'يكون', 'تكون', 'تم', 'يتم',
  'بعد', 'قبل', 'عند', 'حيث', 'أيضا', 'ايضا', 'فقط', 'جميع', 'بين', 'حتى',
  'لم', 'لن', 'هو', 'هي', 'هم', 'نحن', 'أنت', 'انت', 'كما', 'مثل', 'دون',
  'أي', 'اي', 'إذا', 'اذا', 'هل', 'كيف', 'لماذا', 'ماذا', 'متى', 'أين', 'اين',
  'عندما', 'بينما', 'لأن', 'لان', 'يمكن', 'يجب', 'نفس', 'كلا', 'أحد', 'احد',
  // Adverbs and time words; several fold onto transliterated names
  // (الآن "now" and آلان "Alan" share a key).
  'الآن', 'الان', 'اليوم', 'غدا', 'غداً', 'أمس', 'امس', 'هنا', 'هناك', 'جدا', 'جداً',
  'أكثر', 'اكثر', 'أقل', 'اقل', 'كذلك', 'دائما', 'دائماً', 'أحيانا', 'احيانا', 'ربما',
  'معا', 'معاً', 'حاليا', 'حالياً', 'سابقا', 'لاحقا', 'مباشرة', 'قريبا', 'قريباً',
  'يوم', 'شهر', 'سنة', 'عام', 'العام', 'الشهر', 'الأسبوع', 'الاسبوع', 'الساعة',
  'صباحا', 'مساء', 'مساءً', 'كل', 'أول', 'اول', 'آخر', 'اخر', 'الأول', 'الاول', 'الأخير',
  // Report and compliance vocabulary
  'تقرير', 'التقرير', 'امتثال', 'الامتثال', 'بيانات', 'البيانات', 'شخصية',
  'الشخصية', 'حماية', 'الحماية', 'قانون', 'القانون', 'مادة', 'المادة',
  'المواد', 'فحص', 'الفحص', 'ملف', 'الملف', 'ملفات', 'الملفات', 'نتيجة',
  'نتائج', 'النتائج', 'إجمالي', 'اجمالي', 'حسب', 'فئة', 'الفئة', 'خطورة',
  'الخطورة', 'ملخص', 'الملخص', 'عنوان', 'العنوان', 'سطر', 'السطر', 'نوع',
  'النوع', 'عدد', 'العدد', 'مسار', 'المسار', 'وقت', 'الوقت', 'مدة', 'المدة',
  'أعلى', 'اعلى', 'تعريفات', 'شروط', 'معالجة', 'أمن', 'امن', 'الإبلاغ',
  'الابلاغ', 'انتهاك', 'نقل', 'عبر', 'الحدود', 'تعريف', 'المستشهد',
  // Kakashi's own Arabic labels
  'الهوية', 'الإماراتية', 'الاماراتية', 'هاتف', 'إماراتي', 'اماراتي', 'جواز',
  'سفر', 'رقم', 'الرقم', 'التأشيرة', 'رخصة', 'تجارية', 'صندوق', 'بريد',
  'اسم', 'الاسم', 'عربي', 'الموحد', 'ايبان', 'إلكتروني', 'الكتروني',
  'بطاقة', 'ائتمان', 'الضمان', 'الاجتماعي', 'تاريخ', 'الميلاد', 'العمر',
  'الكامل', 'رمز', 'مفتاح', 'اتصال', 'قاعدة', 'سر', 'بيئي', 'خاص', 'وثائق',
  'شخصي', 'اعتمادات', 'جاري', 'للتطبيق', 'تُعرض', 'القيم', 'راجع', 'للتفاصيل',
]);

/**
 * An explicit cue that whatever follows is a person's name. When one of these
 * sits immediately before a match, the "all ordinary words" rejection is
 * overridden -- this is what keeps `Name: Mark Price` from being discarded.
 */
const NAME_CUE_RX = new RegExp(
  '(?:'
  + 'name|full[ \\t]*name|customer|client|employee|staff|contact|owner|'
  + 'applicant|holder|beneficiary|patient|passenger|guest|member|author|'
  + 'signed[ \\t]*by|prepared[ \\t]*by|reviewed[ \\t]*by|approved[ \\t]*by|'
  + 'attn|mr|mrs|ms|miss|dr|prof|eng|sheikh|'
  + 'الاسم|اسم|السيد|السيدة|الآنسة|الدكتور|المهندس|الشيخ|العميل|الموظف'
  + ')[:\\s]*$',
  'i',
);

/** Arabic particles that are strong positive evidence of a personal name. */
const AR_NAME_PARTICLES = new Set(['بن', 'بنت', 'ابن', 'آل', 'ال', 'عبد', 'أبو', 'ابو', 'أم', 'ام']);

// ---------------------------------------------------------------------------
// Places and organisations that look like names.
//
// `Abu Dhabi`, `Ras Al Khaimah`, `Sultan Bin Zayed Street`, `Gulf Logistics`
// and `Visual Studio Code` are capitalised word runs, and most contain at least
// one word that is not ordinary vocabulary, so the stop-list keeps them as
// "names". Masking them costs the requesting agent context it needs, and in the
// Guardian a restricted class it did not need to transform.
//
// The suffix list leaves out words that are also common surnames (Park, Hall,
// King, Bay, Church), so `Grace Park` is still a person.
// ---------------------------------------------------------------------------

/** Last word of a Latin-script run that marks a place or an organisation. */
const EN_PLACE_ORG_SUFFIX = new Set([
  'street', 'st', 'road', 'rd', 'avenue', 'ave', 'boulevard', 'blvd', 'highway',
  'hwy', 'lane', 'square', 'plaza', 'city', 'district', 'emirate', 'island',
  'airport', 'mall', 'tower', 'towers', 'centre', 'center', 'mosque', 'masjid',
  'university', 'college', 'school', 'academy', 'institute', 'hospital',
  'clinic', 'hotel', 'resort', 'stadium', 'museum', 'library', 'souk',
  'station', 'terminal', 'marina', 'bank', 'group', 'holding', 'holdings',
  'llc', 'fze', 'fzco', 'fzllc', 'pjsc', 'psc', 'ltd', 'limited', 'inc', 'corp',
  'corporation', 'company', 'gmbh', 'plc', 'authority', 'ministry', 'council',
  'municipality', 'court', 'foundation', 'association', 'club', 'trading',
  'logistics', 'technologies', 'technology', 'solutions', 'services', 'systems',
  'consulting', 'consultancy', 'partners', 'enterprises', 'industries',
  'investments', 'properties', 'cloud', 'studio', 'code', 'platform', 'support',
  'report', 'plan', 'airways', 'airlines', 'telecom', 'media', 'news',
  'department', 'dept', 'division', 'team', 'office', 'committee', 'board',
  'directorate', 'sector', 'unit',
]);

/** Multi-word place names, lower case. Matched as a whole-word run inside a match. */
const EN_KNOWN_PLACES = [
  'abu dhabi', 'al ain', 'ras al khaimah', 'umm al quwain', 'al dhafra', 'al reem',
  'al barsha', 'al quoz', 'al nahda', 'al qusais', 'al karama', 'al mamzar',
  'jumeirah lake towers', 'business bay', 'downtown dubai', 'palm jumeirah',
  'dubai silicon oasis', 'saudi arabia', 'united arab emirates', 'united states',
  'united kingdom', 'new york', 'new jersey', 'new delhi', 'new zealand',
  'san francisco', 'los angeles', 'las vegas', 'san diego', 'san jose',
  'hong kong', 'sri lanka', 'south africa', 'north america', 'south america',
  'costa rica', 'el salvador', 'puerto rico', 'rio de janeiro', 'buenos aires',
  'kuala lumpur', 'cape town', 'saint petersburg', 'tel aviv',
].map((p) => p.split(' '));

/** First word of an Arabic run that marks a place or an organisation. */
const AR_PLACE_ORG_PREFIX = new Set([
  'شارع', 'طريق', 'مدينة', 'منطقة', 'حي', 'جزيرة', 'إمارة', 'امارة', 'مطار',
  'ميناء', 'مركز', 'مول', 'برج', 'مسجد', 'جامع', 'جامعة', 'كلية', 'مدرسة', 'معهد',
  'أكاديمية', 'اكاديمية', 'مستشفى', 'عيادة', 'فندق', 'بنك', 'مصرف', 'شركة',
  'مؤسسة', 'مجموعة', 'وزارة', 'هيئة', 'دائرة', 'مجلس', 'بلدية', 'محكمة', 'محاكم',
  'نادي', 'ملعب', 'متحف', 'مكتبة', 'سوق', 'محطة', 'حديقة', 'منتزه', 'قسم',
  'إدارة', 'ادارة', 'فرع', 'مشروع',
]);

/** Whole Arabic runs that are places. Compared exactly: Arabic runs are long. */
const AR_KNOWN_PLACES = new Set([
  'أبو ظبي', 'ابو ظبي', 'رأس الخيمة', 'راس الخيمة', 'أم القيوين', 'ام القيوين',
  'الإمارات العربية المتحدة', 'الامارات العربية المتحدة', 'المملكة العربية السعودية',
  'المملكة المتحدة', 'الولايات المتحدة', 'الولايات المتحدة الأمريكية',
]);

/**
 * Is this run of words a place or an organisation rather than a person?
 * @param {string[]} tokens
 */
function isOrgOrPlace(tokens) {
  const words = tokens.map((w) => w.replace(/[.,'’]+$/g, '')).filter(Boolean);
  if (words.length === 0) return false;
  if (/[؀-ۿ]/.test(words[0])) {
    return AR_PLACE_ORG_PREFIX.has(words[0]) || AR_KNOWN_PLACES.has(words.join(' '));
  }
  const lower = words.map((w) => w.toLowerCase());
  if (EN_PLACE_ORG_SUFFIX.has(lower[lower.length - 1])) return true;
  return EN_KNOWN_PLACES.some((place) => {
    for (let i = 0; i + place.length <= lower.length; i++) {
      if (place.every((w, k) => lower[i + k] === w)) return true;
    }
    return false;
  });
}

/**
 * Where the current line starts, looking back at most `max` characters.
 *
 * `text.lastIndexOf('\n', idx)` walks back to the start of the line however
 * long it is, and these checks run once per match: on a one-line JSON file of
 * a few megabytes that made detection quadratic -- 2 MB of hashes took 71 s
 * (#38). A line start further back than `max` is treated as `idx - max`.
 */
function lineStartWithin(text, idx, max) {
  const from = Math.max(0, idx - max);
  const nl = text.slice(from, idx).lastIndexOf('\n');
  return nl === -1 ? from : from + nl + 1;
}

/** Where the current line ends, looking ahead at most `max` characters. */
function lineEndWithin(text, idx, max) {
  const to = Math.min(text.length, idx + max);
  const nl = text.slice(idx, to).indexOf('\n');
  return nl === -1 ? to : idx + nl;
}

/** How far the line-context checks look on either side of a match. */
const LINE_CONTEXT = 256;

/**
 * Shared gate for both name patterns.
 * @param {string[]} tokens - the match split into words
 * @param {Set<string>} common - ordinary words of that language
 * @param {string} text - the full document
 * @param {number} idx - offset of the match
 */
function looksLikeName(tokens, common, text, idx) {
  // A place or an organisation is never a person, even after a cue:
  // `Owner: Gulf Logistics LLC` names a company.
  if (isOrgOrPlace(tokens)) return false;

  // An explicit cue immediately before the match settles it, and outranks
  // everything below -- `Name: Mark Price` is a name however ordinary the words.
  const before = text.slice(Math.max(0, idx - 24), idx);
  if (NAME_CUE_RX.test(before)) return true;

  // Structural signal: a Markdown heading is a section title, not a person.
  // Checked against the line so far rather than the whole document.
  const lineStart = lineStartWithin(text, idx, LINE_CONTEXT);
  const prefix = text.slice(lineStart, idx);
  if ((lineStart === 0 || text[lineStart - 1] === '\n') && /^\s{0,3}#{1,6}\s[^\n]*$/.test(prefix)) return false;

  // Otherwise: keep the match unless every token is an ordinary word.
  return !tokens.every((w) => common.has(w.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Secret assignments (env_secret) and hash references (hex_secret)
// ---------------------------------------------------------------------------

/** A key that names a secret: `DB_PASSWORD`, `client_secret`, `ApiKey`. No capture groups. */
// The name around the keyword is bounded (real keys are well under 100
// characters). Unbounded, `[\w.-]*` on both sides made every start in a long
// `a-a-a-…` run scan the rest of the run for a keyword: quadratic (#38).
const SECRET_KEY = '(?:[A-Za-z_][\\w.-]{0,100})?(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|SECRET[_-]?KEY|CREDENTIAL|HOST|BUCKET|SIGNATURE|HMAC|DSN|WEBHOOK)[\\w.-]{0,100}';

/**
 * Split an env_secret match into its key and value, for each of its forms:
 * `KEY=value` / `"key": "value"`, `<key>value</key>`, and
 * `key="Key" value="value"`.
 * `keyQuoted` / `valueQuoted` say whether form A's key and value were written
 * in quotes; the XML forms count as quoted.
 * @param {string} match
 * @returns {{ key: string, value: string, keyQuoted: boolean, valueQuoted: boolean }}
 */
function splitSecretAssignment(match) {
  if (match.startsWith('<')) {
    const tag = match.match(/^<([^\s>]+)/);
    return {
      key: tag ? tag[1] : '',
      value: match.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, '').trim(),
      keyQuoted: true,
      valueQuoted: true,
    };
  }
  const attr = match.match(/^(?:key|name)[ \t]*=[ \t]*["']([^"']*)["'][\s\S]*value[ \t]*=[ \t]*["']([^"']*)["']$/i);
  if (attr) return { key: attr[1], value: attr[2].trim(), keyQuoted: true, valueQuoted: true };
  const at = match.search(/[:=]/);
  const rawKey = match.slice(0, at).trim();
  const rawValue = match.slice(at + 1).trim();
  return {
    key: rawKey.replace(/["']+$/, ''),
    value: rawValue.replace(/^["']|["']$/g, ''),
    keyQuoted: /["']$/.test(rawKey),
    valueQuoted: /^["']/.test(rawValue),
  };
}

/**
 * Key segments that describe a property of a secret rather than hold it:
 * `max_tokens`, `token_type`, `PASSWORD_MIN_LENGTH`, `TOKEN_TTL`, `SECRET_FILE`.
 */
const SECRET_PROPERTY_SEGMENTS = new Set([
  'max', 'min', 'num', 'len', 'length', 'type', 'kind', 'format', 'expiry', 'expires',
  'expiration', 'ttl', 'timeout', 'lifetime', 'age', 'count', 'limit', 'limits',
  'size', 'port', 'policy', 'rotation', 'strength', 'regex', 'pattern', 'hint',
  'header', 'prefix', 'enabled', 'required', 'file', 'path', 'dir', 'name', 'version',
]);

/** @param {string} key */
function describesSecretProperty(key) {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return segments.some((seg) => SECRET_PROPERTY_SEGMENTS.has(seg));
}

/** Values that stand in for a secret: references, templates, truncations. */
const SECRET_PLACEHOLDER_RX = /^(?:\$\{|\$\(|\{\{|%\(|<[^>]*>?$|\$[A-Za-z_]\w*$|process\.env\b|os\.environ\b|env\(|x{3,}$|\*{3,}$)|\.\.\.|…|^(?:change[_-]?me|replace[_-]?me|your[_-]\S*|todo|redacted|placeholder|dummy)$/i;

/** Loopback and local-only hosts. */
const LOCAL_HOST_RX = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|\[::1\]|host\.docker\.internal)(?::\d+)?$/i;

/** Words that, just before a hex string on the same line, say it is a hash. */
const HASH_CUE_RX = /\b(?:commits?|sha-?(?:1|256|384|512)?(?:sum)?|checksums?|digests?|integrity|hash(?:es)?|revision|rev|merged?|cherry[- ]?pick(?:ed)?|blob|tree|parent|fix(?:es|ed)?|refs?|tags?|objects?)\b[^\n]{0,24}$/i;

/** Words that keep a hex string a secret even when it has hash-like context. */
const HEX_SECRET_CUE_RX = /secret|token|passw(?:or)?d|api[ _-]?key|private[ _-]?key|access[ _-]?key|\bkey\b|credential|signature|hmac|auth/i;

/**
 * Is this 40/64/128-character hex string a commit id or a checksum rather than
 * a secret? Only standard hash lengths qualify, and a secret-like word on the
 * same line always wins.
 *
 *   commit 9fceb02d...                cue word before it
 *   - Fixed login redirect (9fceb02d...)   changelog reference
 *   9fceb02d...  dist/app.tar.gz      checksum or `git log --oneline` listing
 *   .../commit/9fceb02d...            commit URL, `pkg@<sha>`, `#<sha>`
 *
 * @param {string} match
 * @param {string} text
 * @param {number} idx
 */
function looksLikeHashReference(match, text, idx) {
  if (![40, 64, 128].includes(match.length)) return false;
  const lineStart = lineStartWithin(text, idx, LINE_CONTEXT);
  const before = text.slice(lineStart, idx);
  const after = text.slice(idx + match.length, lineEndWithin(text, idx + match.length, LINE_CONTEXT));
  if (HEX_SECRET_CUE_RX.test(before)) return false;
  if (HASH_CUE_RX.test(before)) return true;
  if (/(?:\/commits?\/|\/blob\/|\/tree\/|\/compare\/[^\s]*|@|#)$/.test(before)) return true;
  if (/[([]\s*$/.test(before) && /^\s*[)\]]/.test(after)) return true;
  // A line that starts with the hash and goes on to a file name or a message.
  if (/^[\s>*+-]*$/.test(before) && /^[ \t]+\S/.test(after) && !HEX_SECRET_CUE_RX.test(after)) return true;
  return false;
}

/**
 * Does this base64 decode to `user:password`? Tells a Basic credential from
 * the word "basic" followed by a long word.
 * @param {string} b64
 */
function isBasicCredential(b64) {
  const decoded = Buffer.from(b64, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== b64.replace(/=+$/, '')) return false;
  return /^[^\x00-\x1f:]+:[^\x00-\x1f]+$/.test(decoded.toString('utf8'))
    && !decoded.toString('utf8').includes('\ufffd');
}

/** A label that says the next number is a phone number. */
const PHONE_CUE_RX = /\b(?:tel|telephone|phone|mobile|mob|cell|fax|contact|whats ?app)\b|هاتف|جوال|موبايل|فاكس/i;

/** An AWS access key id or an AWS / secret-access-key label. */
const AWS_SECRET_CUE_RX = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\baws\b|aws_|secret[ \t_-]*access[ \t_-]*key/i;

// ---------------------------------------------------------------------------
// Context helpers for passport, date and email
// ---------------------------------------------------------------------------

/** Up to `max` characters of the current line before `idx`. */
function linePrefix(text, idx, max) {
  return text.slice(lineStartWithin(text, idx, max), idx);
}

/** A label that says the next value is a passport number. */
const PASSPORT_CUE_RX = /(?:passport|travel[ \t_-]*doc|document[ \t_-]*(?:no|number|#)|جواز)/i;

/** A label that says the next code is a business document, not a passport. */
const DOCUMENT_CODE_CUE_RX = /\b(?:invoice|inv|order|ref|reference|sku|po|ticket|case|build|version|serial|part|model|item|product|tracking|booking|confirmation|receipt|quote|contract)\b[^\n]{0,12}$|(?:فاتورة|طلب|مرجع)[^\n]{0,12}$/i;

/** Eight digits that read as a calendar date (19xx/20xx, month 01-12, day 01-31). */
function looksLikeYyyymmdd(digits) {
  const m = /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.exec(digits);
  return Boolean(m);
}

/** A cue that the next date is a person's date of birth. */
const BIRTH_CUE_RX = /(?:\bdob\b|d\.o\.b|birth|born|ميلاد|مواليد)/i;

/** A cue that the next date belongs to a business document. */
const DOCUMENT_DATE_CUE_RX = /\b(?:invoice|inv|due|order(?:ed)?|payment|paid|delivery|delivered|shipped|created|updated|modified|generated|printed|report(?:ed|ing)?|as of|period|effective|posted|published|released?|version|build|deadline|meeting|scheduled|statement|billing)\b[^\n]{0,16}$|(?:فاتورة|الاستحقاق|الطلب|الدفع|التقرير)[^\n]{0,16}$/i;

/** An email-shaped string whose "domain" ends in a file extension. */
const FILE_EXTENSION_TLD_RX = /\.(?:png|jpe?g|gif|svg|webp|ico|bmp|tiff?|m?js|cjs|tsx?|jsx|s?css|json|ya?ml|xml|html?|pdf|txt|csv|map|woff2?|ttf|eot|mp[34]|wav|avi)$/i;

// ---------------------------------------------------------------------------
// Identifier helpers: card prefixes, Emirates ID labels, IBAN detection
// ---------------------------------------------------------------------------

/**
 * Issuer prefixes of the card networks: Visa 4; Mastercard 51-55 and
 * 2221-2720; Mir 2200-2204; Amex 34/37; Diners 30/36/38/39; JCB 35;
 * Maestro 50/56-58/6x; Discover and UnionPay 6x. Nothing starts with 1, 7, 8,
 * 9 or 0 -- which rules out timestamps and 784-prefixed Emirates IDs.
 */
const CARD_PREFIX_RX = /^(?:4|5[0-8]|2(?:2[2-9]|[3-6]\d|7[0-2])|220[0-4]|3[0-9]|6)/;

/** A label just before a bare 15-digit number that says it is an Emirates ID. */
const EMIRATES_ID_CUE_RX = /(?:emirates[ \t_-]*id|\beid\b|national[ \t_-]*id|\bid[ \t_-]*(?:no|number|#)|رقم[ \t]*الهوية|الهوية|هوية)[^\n]{0,12}$/i;

/**
 * IBAN length per country (ISO 13616 registry). Every country's IBAN has one
 * fixed length, which pins down where an IBAN ends: mod-97 alone passes about
 * 1 in 97 strings, so `GB82 WEST ... 32 USD` would also "pass" with the trailing
 * word included.
 */
const IBAN_LENGTHS = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29,
  BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29,
  ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28,
  HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20,
  LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22,
  MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29,
  PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24,
  SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

/**
 * Find IBANs from any country except the UAE (see `uae_iban`).
 *
 * A candidate is two letters, two check digits and more alphanumerics,
 * optionally grouped by single spaces. The IBAN is the prefix that ends at a
 * word boundary, has exactly its country's registered length, and passes the
 * mod-97 checksum -- so a trailing word such as `USD` is left out.
 *
 * @param {string} text
 * @returns {Array<{ start: number, end: number, original: string }>}
 */
function detectIbans(text) {
  const out = [];
  const rx = /\b[A-Z]{2}\d{2}(?:[ \t]?[A-Z0-9]){11,40}/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const run = m[0];
    let found = null;
    for (let end = run.length; end >= 15 && !found; end--) {
      const atBoundary = end === run.length || /[ \t]/.test(run[end]);
      if (!atBoundary || /[ \t]/.test(run[end - 1])) continue;
      const after = text[m.index + end] || '';
      if (/[A-Za-z0-9]/.test(after) && end === run.length) continue; // glued to more text
      const candidate = run.slice(0, end);
      const compact = candidate.replace(/[ \t]/g, '');
      const country = compact.slice(0, 2);
      if (country !== 'AE' && compact.length === IBAN_LENGTHS[country] && isValidIban(compact)) {
        found = candidate;
      }
    }
    if (found) {
      out.push({ start: m.index, end: m.index + found.length, original: found });
      rx.lastIndex = m.index + found.length;
    } else {
      rx.lastIndex = m.index + 2;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checksum helpers
//
// These are exported as reusable primitives. They are NOT wired into the
// pattern `validate` hooks by default because:
//   (a) the existing test fixtures use synthetic IDs whose check digits are
//       not real (e.g. 784-1988-1234567-0), and enabling strict validation
//       would break those tests without adding real safety;
//   (b) the compliance/reporter layer (A5, A2) uses these helpers to add a
//       "checksum-verified" badge to each finding — that is the correct
//       place for strict validation, not the pattern matcher which needs to
//       stay lenient enough to flag suspect-looking IDs even when the check
//       digit is wrong (attackers frequently transpose digits).
// ---------------------------------------------------------------------------

/**
 * Luhn (ISO/IEC 7812-1) checksum for a digits-only string.
 * @param {string} digits
 * @returns {boolean}
 */
function luhnCheck(digits) {
  if (typeof digits !== 'string' || digits.length === 0) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const n = parseInt(digits[i], 10);
    if (Number.isNaN(n)) return false;
    let contrib = n;
    if (alt) {
      contrib = n * 2;
      if (contrib > 9) contrib -= 9;
    }
    sum += contrib;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Emirates ID checksum verification.
 * Emirates ID is 15 digits (784-YYYY-NNNNNNN-C) with a Luhn check digit.
 * @param {string} id — may contain dashes or spaces
 * @returns {boolean}
 */
function isValidEmiratesId(id) {
  const digits = String(id || '').replace(/\D/g, '');
  if (digits.length !== 15) return false;
  if (!/^784/.test(digits)) return false;
  return luhnCheck(digits);
}

/**
 * IBAN mod-97 checksum (ISO 13616).
 * @param {string} iban — spaces/case tolerated
 * @returns {boolean}
 */
function isValidIban(iban) {
  const clean = String(iban || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(clean)) return false;
  // Rearrange: move first four chars to the end.
  const rearranged = clean.slice(4) + clean.slice(0, 4);
  // Convert letters to digits (A=10..Z=35).
  const numeric = rearranged.replace(/[A-Z]/g, (c) => (c.charCodeAt(0) - 55).toString());
  // Mod 97 via 7-digit chunks (keeps us out of BigInt land).
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = parseInt(String(remainder) + numeric.slice(i, i + 7), 10) % 97;
  }
  return remainder === 1;
}

// ---------------------------------------------------------------------------
// Patterns
//
// Every pattern has:
//   id        — stable key; used in token replacement `[<ID>_<n>]`
//   label     — English display name (used in reports, verbose output)
//   labelAr   — Arabic display name (used when LANG=ar* or --lang ar)
//   cat       — 'id' | 'pii' | 'cred'
//   rx        — regex to match
//   validate  — optional predicate; return false to reject a match
//   fakeValues — used by --mode fake
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Names (full_name, non_latin_name)
// ---------------------------------------------------------------------------

/**
 * One Title Case word of a Latin name: `Sarah`, `Al-Kaabi`, `Jean-Luc`,
 * `O'Brien`, `McDonald`, `MacLeod`.
 */
// At most three hyphens (`Al-Kaabi`, `Jean-Pierre`, `Bin-Al-Nahyan`).
// Unbounded, a long `Ab-Ab-Ab-…` run was re-scanned from every start: quadratic (#38).
const TITLE_WORD = "(?:[A-Z]['’][A-Z][a-z]+|(?:Mc|Mac)?[A-Z][a-z]+(?:-[A-Z]?[a-z]+){0,3})";
/** Lower-case connectors a Title Case name may contain: `bin`, `dela`, `van`. */
const NAME_PARTICLE = '(?:bin|bint|ibn|al|el|de|del|dela|della|da|das|dos|du|van|von|der|den|le|la|di|y)';
/**
 * A greeting or title is not part of the name after it: `Dear Customer` is no
 * name at all, and in `Dr Kumar` or `Dear Rajesh Kumar` only the name is
 * masked (the salutation detector in name-spans.js finds a lone `Kumar`).
 */
const SALUTATION_WORD = '(?:Dear|Hi|Hello|Hey|Thanks|Thank|Cheers|Regards|Kind|Best|Welcome|Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Eng|Sheikh|Sheikha|Attn)';
/**
 * Two or more Title Case words, optionally joined by up to two particles:
 * `Sarah Connor`, `Abdulla bin Rashid`, `Jose dela Cruz`, `Fatima Al-Kaabi`,
 * `James O'Brien`.
 */
const FULL_NAME_RX = new RegExp(
  `\\b(?!${SALUTATION_WORD}\\b)${TITLE_WORD}(?:[ \\t]+(?:${NAME_PARTICLE}[ \\t]+){0,2}${TITLE_WORD})+\\b`,
  'g',
);

/** Prefixes that make a hyphenated word a name part: `Al-Kaabi`, `Bin-Zayed`. */
const HYPHEN_NAME_PREFIX = new Set(['al', 'el', 'abu', 'abd', 'abdul', 'bin', 'ben', 'ibn', 'bint']);

/** Title Case alone is 'low'; two listed names make it 'medium'; a cue 'high'. */
function fullNameConfidence(match, text, idx) {
  if (NAME_CUE_RX.test(text.slice(Math.max(0, idx - 24), idx))) return 'high';
  const words = match.split(/\s+/).filter((w) => !/^[a-z]+$/.test(w));
  return words.filter((w) => isKnownName(w) && !isAmbiguousName(w)).length >= 2 ? 'medium' : 'low';
}

function fullNameTitleCase(match, text, idx) {
  const tokens = match.split(/\s+/);
  // Title Case headings are full of hyphenated compounds (`Real-World
  // Validation`, `Cross-Border Transfer`); a hyphenated name has an Arabic
  // prefix (`Al-Kaabi`) or a listed name in it (`Jean-Luc`, `Smith-Jones`).
  for (const t of tokens) {
    if (!t.includes('-')) continue;
    const parts = t.toLowerCase().split('-');
    if (HYPHEN_NAME_PREFIX.has(parts[0])) continue;
    if (!parts.some((p) => !COMMON_EN.has(p) && isKnownName(p) && !isAmbiguousName(p))) return false;
  }
  // A capitalised sentence opener glued to a name (`Today Mohammed`,
  // `Please Sarah`) is not part of it: reject the run here, and the name
  // detector (fullNameTrimmed) emits it without the opener.
  if (leadingOpeners(tokens) > 0) return false;
  return looksLikeName(tokens, COMMON_EN, text, idx);
}

/** Function words that may open a sentence before a name, even if listed as one. */
const SENTENCE_OPENERS = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'and', 'or', 'but', 'so',
  'then', 'when', 'if', 'also', 'today', 'yesterday', 'tomorrow', 'please', 'ask', 'tell', 'call', 'email']);

/**
 * How many leading tokens are ordinary words that are not given names: `Today`
 * in `Today Rajesh Kumar`. `Will` in `Will Smith` stays (a name).
 */
function leadingOpeners(tokens) {
  let k = 0;
  while (k < tokens.length - 1) {
    const lw = tokens[k].toLowerCase();
    if (SENTENCE_OPENERS.has(lw) || (COMMON_EN.has(lw) && !isGivenName(tokens[k]))) k++;
    else break;
  }
  return k;
}

/**
 * Title Case runs that start with an ordinary word, emitted without it when at
 * least two words remain: `Today Rajesh Kumar` -> `Rajesh Kumar`. (A single
 * remaining word is left to the repeat detector.)
 */
function fullNameTrimmed(text) {
  const rx = new RegExp(FULL_NAME_RX.source, 'g');
  const spans = [];
  let m;
  while ((m = rx.exec(text)) !== null) {
    const tokens = m[0].split(/([ \t]+)/);
    const words = tokens.filter((_, i) => i % 2 === 0);
    const k = leadingOpeners(words);
    if (k === 0) continue;
    const rest = words.slice(k);
    if (rest.length < 2 || /^[a-z]/.test(rest[0])) continue;
    // The opener was the only evidence the run was a heading, so what is left
    // must hold a listed name (`What Kakashi Catches` -> nothing).
    if (!rest.some((w) => !COMMON_EN.has(w.toLowerCase()) && isKnownName(w) && !isAmbiguousName(w))) continue;
    const offset = tokens.slice(0, k * 2).join('').length;
    const start = m.index + offset;
    const original = m[0].slice(offset);
    if (!fullNameTitleCase(original, text, start)) continue;
    spans.push({ start, end: start + original.length, original, confidence: fullNameConfidence(original, text, start) });
  }
  return spans;
}

const detectPersonFields = createPersonFieldDetector({
  commonEn: COMMON_EN,
  commonAr: COMMON_AR,
  isOrgOrPlace,
  // Phase 2: a value under a WEAK key (`name`) must contain a listed name, so a
  // product catalogue's `name` column (`wireless mouse`, `USB CABLE`) is not a
  // column of people.
  hasNameEvidence: (words) => words.some((w) => isKnownName(w) && !isAmbiguousName(w)),
});

const nameSpans = createNameSpanDetectors({
  commonEn: COMMON_EN,
  commonAr: COMMON_AR,
  isOrgOrPlace,
  nameCueRx: NAME_CUE_RX,
  titleCaseRx: FULL_NAME_RX,
  titleCaseValidate: fullNameTitleCase,
});

const BASE_PATTERNS = [
  // ---- ID & Documents ------------------------------------------------------
  {
    id: 'national_id',
    label: 'Emirates ID',
    labelAr: 'الهوية الإماراتية',
    cat: 'id',
    // Emirates ID: 784-YYYY-NNNNNNN-D, also written with spaces or with no
    // separator at all (the usual form in databases). The separator must be the
    // same throughout.
    //
    // The dashed form is the printed format and stays lenient: a transposed
    // digit is still worth flagging. The other two forms are only 15 digits
    // starting 784, so they need the Emirates ID checksum or a nearby label.
    // The reporter (A2/A5) badges any finding that passes `isValidEmiratesId`
    // as checksum-verified.
    rx: /\b784([ -]?)\d{4}\1\d{7}\1\d\b/g,
    validate: (match, text, idx) => match.includes('-')
      || isValidEmiratesId(match)
      || EMIRATES_ID_CUE_RX.test(text.slice(Math.max(0, idx - 32), idx)),
    fakeValues: ['784-1990-9999999-0', '784-1985-1234567-1'],
  },
  {
    id: 'intl_phone',
    label: 'UAE Phone',
    labelAr: 'هاتف إماراتي',
    cat: 'id',
    // Matches UAE mobile (+971 5x…) and UAE landline (+971 2/3/4/6/7/9) in
    // international, national-with-country-code (00971), or local (0X) forms.
    // The international form must not start inside a longer number
    // (`SKU 8971501234567`); the national form has its own `\b`.
    rx: /(?<![\d+])(?:\+971|00971|971)[ \t.-]?(?:5[0-9]|2|3|4|6|7|9)[ \t.-]?\d{3}[ \t.-]?\d{4}\b|\b0(?:5[0-9]|2|3|4|6|7|9)[ \t.-]?\d{3}[ \t.-]?\d{4}\b/g,
    fakeValues: ['+971501234567', '0501234567'],
  },
  {
    id: 'passport',
    label: 'Passport',
    labelAr: 'جواز سفر',
    cat: 'id',
    // ICAO-style passport numbers: 2 letters + 6-9 digits, or P<letter> + 7-8 digits.
    // Covers UAE, most EU, US, and Commonwealth passport formats.
    rx: /\b(?:[A-Z]{2}\d{6,9}|P[A-Z]\d{7,8})\b/g,
    // Two capitals and digits is also how invoice, order and ticket codes look
    // (`Invoice IN20240115`). A label naming something else, or digits that
    // read as a YYYYMMDD date, rule it out -- unless a passport label is there.
    validate: (match, text, idx) => {
      const before = linePrefix(text, idx, 40);
      if (PASSPORT_CUE_RX.test(before)) return true;
      if (DOCUMENT_CODE_CUE_RX.test(before)) return false;
      return !looksLikeYyyymmdd(match.replace(/\D/g, ''));
    },
    fakeValues: ['MO1234567', 'AB12345678'],
  },
  {
    id: 'visa_id',
    label: 'Visa Number',
    labelAr: 'رقم التأشيرة',
    cat: 'id',
    // UAE residence visa: NNN/YYYY/NNNNNNN.
    rx: /\b\d{3}\/\d{4}\/\d{7}\b/g,
    fakeValues: ['201/2024/1234567'],
  },
  {
    id: 'trade_lic',
    label: 'Trade License',
    labelAr: 'رخصة تجارية',
    cat: 'id',
    // Dubai DED / commercial CN / TL-prefixed trade license numbers.
    // Case-sensitive, with at least one digit: `cn-north-1` (an AWS region)
    // matched the old case-insensitive form.
    rx: /\b(?:DED|CN|TL)-(?=[A-Z0-9]*\d)[A-Z0-9]{4,10}\b/g,
    fakeValues: ['DED-123456', 'CN-789012'],
  },
  {
    id: 'pobox',
    label: 'P.O. Box',
    labelAr: 'صندوق بريد',
    cat: 'id',
    rx: /\bP\.?[ \t]*O\.?[ \t]*Box[ \t]+\d{1,6}\b/gi,
    fakeValues: ['P.O. Box 12345'],
  },
  {
    id: 'non_latin_name',
    label: 'Arabic Name',
    labelAr: 'اسم عربي',
    cat: 'id',
    // Arabic names in running text. It used to match any run of two or more
    // Arabic words and reject only runs made entirely of stop-words, so
    // ordinary sentences (`يرجى مراجعة التقرير المرفق قبل الاجتماع`) were
    // "names". A span must now START at a listed given name, or at a head
    // particle followed by a name (`عبد الله`, `أبو بكر`), and continues
    // through listed names, nasab particles (`بن`, `بنت`, `آل`) and Gulf
    // family names in the nisba form (`الكعبي`). A lone name counts after a
    // title or greeting (`السيد راشد`). See name-spans.js and names.js.
    detect: (text) => nameSpans.detectArabic(text),
    fakeValues: ['محمد أحمد', 'فاطمة علي'],
  },
  {
    id: 'unified_id',
    label: 'Unified ID',
    labelAr: 'الرقم الموحد',
    cat: 'id',
    // 15-digit unified identifier (e.g. UAE UID starts with "10").
    rx: /\b10\d{13}\b/g,
    fakeValues: ['101234567890123'],
  },
  {
    id: 'uae_iban',
    label: 'UAE IBAN',
    labelAr: 'ايبان إماراتي',
    cat: 'id',
    // UAE IBAN: AE + 2 check digits + 3-digit bank + 16-digit account = 23 chars.
    // Format tolerates optional spaces every 4 chars (bank-statement style).
    rx: /\bAE\d{2}(?:[ \t]?\d{4}){4}[ \t]?\d{3}\b|\bAE\d{21}\b/g,
    fakeValues: ['AE070331234567890123456'],
    // Strict-mode reporters may additionally call isValidIban(match).
  },
  {
    id: 'iban',
    label: 'IBAN',
    labelAr: 'رقم آيبان',
    cat: 'id',
    // Every other country's IBAN (Saudi, GCC, UK, EU, ...); `uae_iban` keeps
    // AE. Found by detectIbans() rather than a regex alone, because a grouped
    // IBAN followed by a short word (`... 3210 USD`) would otherwise be matched
    // together with the word, fail its checksum and be missed.
    detect: detectIbans,
    fakeValues: ['GB82WEST12345698765432', 'SA0380000000608010167519'],
  },
  // ---- Personal Info -------------------------------------------------------
  {
    id: 'email',
    label: 'Email',
    labelAr: 'بريد إلكتروني',
    cat: 'pii',
    // Bounded at the RFC limits (64-character local part, 253-character
    // domain). Unbounded, every word boundary in a long `a.a.a.…` run consumed
    // the rest of the run and backed off looking for an `@`: quadratic (#38).
    rx: /\b[\w.+-]{1,64}@[\w.-]{1,253}\.[a-zA-Z]{2,63}\b/g,
    // `logo@2x.png` is a file name. Only extensions that are not also real
    // top-level domains are rejected (`.md`, `.zip`, `.mov` are TLDs).
    validate: (match) => !FILE_EXTENSION_TLD_RX.test(match),
    fakeValues: ['user_a@example.com', 'user_b@example.org'],
  },
  {
    id: 'phone',
    label: 'Phone',
    labelAr: 'هاتف',
    cat: 'pii',
    // Require explicit separators or a leading `+` so we don't grab 8-digit
    // substrings out of tokens / cluster IDs / hostnames. Accepted shapes:
    //   intl:     +1-415-555-0188   +44 20 7946 0521   +91-22-2493-1234
    //   E.164:    +447946095812     +966501234567  (how databases and APIs store them)
    //   parens:   (415) 555-0188
    //   us:       415-555-0188      415.555.0188       415 555 0188
    //   national: 020 7946 0958     0161 496 0000  (trunk 0, 3-4-4 or 4-3-4;
    //             only after a phone label, see validate)
    rx: /(?:\+\d{1,3}[ \t.-]\d{1,4}[ \t.-]\d{2,4}[ \t.-]\d{3,4}|(?<![\w+])\+[1-9]\d{7,14}|\(\d{2,4}\)[ \t]*\d{3}[ \t.-]\d{4}|\b\d{3}[ \t.-]\d{3}[ \t.-]\d{4}|\b0(?:\d{2}[ \t.-]\d{4}|\d{3}[ \t.-]\d{3})[ \t.-]\d{4})\b/g,
    validate: (match, text, idx) => {
      const digits = match.replace(/\D/g, '');
      if (digits.length < 9 || digits.length > 15) return false;
      if (/^971/.test(digits)) return false; // covered by intl_phone (UAE)
      // A national number has no country code to mark it, so `020 7946 0958`
      // needs a label: account and reference numbers use the same grouping.
      if (/^0(?:\d{2}[ \t.-]\d{4}|\d{3}[ \t.-]\d{3})[ \t.-]\d{4}$/.test(match)
        && !PHONE_CUE_RX.test(text.slice(Math.max(0, idx - 40), idx))) return false;
      // Reject when embedded in a longer alphanumeric/digit-hyphen sequence
      // (e.g. inside "acme-prod-9842" or "0125-123456-abcd1234")
      const before = text.slice(Math.max(0, idx - 1), idx);
      const after = text.slice(idx + match.length, idx + match.length + 1);
      if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) return false;
      return true;
    },
    fakeValues: ['+1-555-555-0100', '+44 20 7946 0958'],
  },
  {
    id: 'ip',
    label: 'IP Address',
    labelAr: 'عنوان IP',
    cat: 'pii',
    rx: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g,
    fakeValues: ['192.168.1.1', '10.0.0.1'],
  },
  {
    id: 'cc',
    label: 'Credit Card',
    labelAr: 'بطاقة ائتمان',
    cat: 'pii',
    // Visa/MC/Discover (4-4-4-4) | Amex (4-6-5) | continuous 13-19 digits
    rx: /\b(?:\d{4}[ \t-]?){3}\d{4}\b|\b\d{4}[ \t-]\d{6}[ \t-]\d{5}\b|\b\d{13,19}\b/g,
    // Card numbers carry a Luhn check digit; without it every 13-19 digit
    // number (millisecond timestamps, order ids) was a "card". A run of digits
    // with no separators must also start like a card network's number.
    validate: (match) => {
      const digits = match.replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 19) return false;
      if (!luhnCheck(digits)) return false;
      return !/^\d+$/.test(match) || CARD_PREFIX_RX.test(digits);
    },
    fakeValues: ['4111-1111-1111-1111'],
  },
  {
    id: 'ssn',
    label: 'SSN / National ID',
    labelAr: 'رقم الضمان الاجتماعي',
    cat: 'pii',
    rx: /\b\d{3}-\d{2}-\d{4}\b/g,
    fakeValues: ['123-45-6789'],
  },
  {
    id: 'dob',
    label: 'Date of Birth',
    labelAr: 'تاريخ الميلاد',
    cat: 'pii',
    rx: /(?:date[ \t]*of[ \t]*birth|dob|birth[ \t]*date|born[ \t]*on)[: \t]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/gi,
    fakeValues: ['01/01/1990'],
  },
  {
    id: 'date',
    label: 'Date',
    labelAr: 'تاريخ',
    cat: 'pii',
    rx: /\b(?:0?[1-9]|[12]\d|3[01])[\/\-](?:0?[1-9]|1[0-2])[\/\-](?:19|20)\d{2}\b|\b(?:0?[1-9]|1[0-2])[\/\-](?:0?[1-9]|[12]\d|3[01])[\/\-](?:19|20)\d{2}\b/g,
    // Dates on business documents (`Invoice date`, `Due`, `Order placed`) are
    // not personal data. A birth cue overrides that; an unlabelled date is
    // still flagged.
    validate: (match, text, idx) => {
      const before = linePrefix(text, idx, 32);
      if (BIRTH_CUE_RX.test(before)) return true;
      return !DOCUMENT_DATE_CUE_RX.test(before);
    },
    fakeValues: ['15/03/2024'],
  },
  {
    id: 'age',
    label: 'Age',
    labelAr: 'العمر',
    cat: 'pii',
    rx: /\b(?:age|aged)[: \t]+\d{1,3}\b/gi,
    fakeValues: ['age: 34'],
  },
  {
    id: 'full_name',
    label: 'Full Name',
    labelAr: 'الاسم الكامل',
    cat: 'pii',
    // Title Case words, now also across particles, hyphens and apostrophes
    // (`Abdulla bin Rashid`, `Fatima Al-Kaabi`, `James O'Brien`).
    rx: FULL_NAME_RX,
    // Keep unless every token is an ordinary English word; an explicit name cue
    // before the match overrides that. See looksLikeName() for why the rule is
    // asymmetric.
    validate: fullNameTitleCase,
    // Title Case alone is weak evidence; a cue before it or listed names in it
    // raise it.
    confidence: fullNameConfidence,
    // Names found by what surrounds or makes them rather than by their shape:
    // the field they sit in (a `full_name` column, a `"customer"` key, a
    // `Name:` line -- person-fields.js), and the name list for lower-case and
    // ALL-CAPS names in text, a first name after `Thanks,` and repeats of a
    // full name found elsewhere in the text (name-spans.js).
    detect: (text) => {
      const fields = detectPersonFields(text).map((s) => ({ ...s, confidence: 'high' }));
      const trimmed = fullNameTrimmed(text);
      return fields.concat(trimmed, nameSpans.detectLatin(text, fields.concat(trimmed)));
    },
    fakeValues: ['John Smith', 'Jane Doe'],
  },
  // ---- Credentials ---------------------------------------------------------
  {
    id: 'jwt',
    label: 'JWT Token',
    labelAr: 'رمز JWT',
    cat: 'cred',
    rx: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    fakeValues: ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  },
  {
    id: 'ssh_key',
    label: 'Private Key',
    labelAr: 'مفتاح خاص',
    cat: 'cred',
    // PEM and OpenSSH keys, password-protected PKCS#8 (`ENCRYPTED PRIVATE
    // KEY`), DSA, and PGP secret-key blocks. The END line must name the same
    // block as the BEGIN line.
    // The body is bounded -- the largest real private key (16384-bit RSA) is
    // about 12.6 KB -- and stops at the next BEGIN line. Unbounded, every
    // BEGIN without an END scanned to the end of the text: quadratic on
    // repeated headers (#38).
    rx: /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?)-----(?:(?!-----BEGIN )[\s\S]){0,20000}?-----END \1-----/g,
    fakeValues: ['-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----'],
  },
  {
    id: 'aws_key',
    label: 'AWS Key',
    labelAr: 'مفتاح AWS',
    cat: 'cred',
    rx: /\b(?:AKIA|ASIA|AROA)[A-Z0-9]{12,16}\b/g,
    fakeValues: ['AKIAIOSFODNN7EXAMPLE'],
  },
  {
    id: 'openai_key',
    label: 'OpenAI Key',
    labelAr: 'مفتاح OpenAI',
    cat: 'cred',
    // Covers legacy sk-... and current sk-proj-* / sk-svcacct-* / sk-admin-*
    rx: /\bsk-(?:proj-|svcacct-|admin-|None-)?[A-Za-z0-9_-]{20,}\b/g,
    // Don't double-match Anthropic keys (they start with sk-ant-)
    validate: (match) => !/^sk-ant-/.test(match),
    fakeValues: ['sk-proj-abc123def456ghi789jkl012mno345pqr678'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic Key',
    labelAr: 'مفتاح Anthropic',
    cat: 'cred',
    rx: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    fakeValues: ['sk-ant-api03-abc123def456ghi789jkl012mno'],
  },
  {
    id: 'hf_token',
    label: 'HuggingFace Token',
    labelAr: 'رمز HuggingFace',
    cat: 'cred',
    rx: /\bhf_[A-Za-z0-9]{20,}\b/g,
    fakeValues: ['hf_abc123def456ghi789jkl012mno345'],
  },
  {
    id: 'gh_token',
    label: 'GitHub Token',
    labelAr: 'رمز GitHub',
    cat: 'cred',
    // Classic tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) and fine-grained
    // personal access tokens (`github_pat_`).
    rx: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/g,
    fakeValues: ['ghp_abc123def456ghi789jkl012'],
  },
  {
    id: 'slack',
    label: 'Slack Token',
    labelAr: 'رمز Slack',
    cat: 'cred',
    rx: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    fakeValues: ['xoxb-1234567890-1234567890123-abc123def456'],
  },
  {
    id: 'stripe',
    label: 'Stripe Key',
    labelAr: 'مفتاح Stripe',
    cat: 'cred',
    // Secret, publishable and restricted keys, and webhook signing secrets.
    rx: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b|\bwhsec_[A-Za-z0-9+/]{24,}={0,2}/g,
    // Deliberately `sk_test_`, not `sk_live_`, and self-describing.
    //
    // fakeValues are what `--mode fake` writes into a masked file, so they end
    // up in files people commit. A `sk_live_`-shaped placeholder is treated as
    // a real credential by GitHub push protection and every other secret
    // scanner, which means the masked output -- the thing Kakashi produced to
    // make the file safe to share -- would itself block the user's push. It
    // also blocked this repository's own.
    fakeValues: ['sk_test_EXAMPLEplaceholderNOTAREALKEY'],
  },
  {
    id: 'gitlab_token',
    label: 'GitLab Token',
    labelAr: 'رمز GitLab',
    cat: 'cred',
    // Personal, deploy, runner, pipeline-trigger, CI-job, feed, OAuth-app and
    // agent tokens.
    rx: /\bgl(?:pat|dt|rt|ptt|cbt|ft|oas|soat|imt|agent)-[A-Za-z0-9_-]{20,}/g,
    fakeValues: [['glpat', 'EXAMPLEplaceholder0KEY'].join('-')],
  },
  {
    id: 'google_api_key',
    label: 'Google API Key',
    labelAr: 'مفتاح Google API',
    cat: 'cred',
    rx: /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
    fakeValues: [['AI', 'za', 'EXAMPLE_placeholder_NOT_A_REAL_KEY'.padEnd(35, '0')].join('')],
  },
  {
    id: 'sendgrid_key',
    label: 'SendGrid Key',
    labelAr: 'مفتاح SendGrid',
    cat: 'cred',
    rx: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
    fakeValues: [['SG', 'EXAMPLEplaceholder0000', 'NOTAREALKEY'.padEnd(43, '0')].join('.')],
  },
  {
    id: 'npm_token',
    label: 'npm Token',
    labelAr: 'رمز npm',
    cat: 'cred',
    rx: /\bnpm_[A-Za-z0-9]{36}\b/g,
    fakeValues: [['npm', 'EXAMPLEplaceholderNOTAREALKEY'.padEnd(36, '0')].join('_')],
  },
  {
    id: 'slack_webhook',
    label: 'Slack Webhook',
    labelAr: 'رابط Slack Webhook',
    cat: 'cred',
    // The URL is the credential: anyone holding it can post to the channel.
    rx: /\bhttps:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_\/-]{20,}/g,
    fakeValues: [['https://hooks', 'slack', 'com/services/T00000000/B00000000/EXAMPLEplaceholder000'].join('.')],
  },
  {
    id: 'bearer',
    label: 'Bearer Token',
    labelAr: 'رمز Bearer',
    cat: 'cred',
    rx: /\bBearer[ \t]+[A-Za-z0-9._\-+/=]{20,}\b/gi,
    fakeValues: ['Bearer abc123def456ghi789jkl012mno345'],
  },
  {
    id: 'basic_auth',
    label: 'Basic Auth',
    labelAr: 'مصادقة Basic',
    cat: 'cred',
    // `Authorization: Basic <base64 of user:password>`. Only a value that
    // decodes to `user:password` counts, so the word "basic" in prose does not.
    rx: /\bBasic[ \t]+[A-Za-z0-9+/]{8,}={0,2}(?![A-Za-z0-9+/=])/gi,
    validate: (match) => isBasicCredential(match.replace(/^Basic[ \t]+/i, '')),
    fakeValues: [`Basic ${Buffer.from('example:not-a-real-password').toString('base64')}`],
  },
  {
    id: 'db_conn',
    label: 'Database Connection',
    labelAr: 'اتصال قاعدة بيانات',
    cat: 'cred',
    // Standard:  postgresql://user:pass@host/db
    // JDBC:      jdbc:databricks://host:443/path  (sub-protocol after jdbc:)
    rx: /\b(?:postgresql|postgres|mysql|mongodb(?:\+srv)?|redis|mssql|sqlite|oracle):\/\/[^\s"'<>]+|\bjdbc:[a-z]+:\/\/[^\s"'<>]+|\bjdbc:\/\/[^\s"'<>]+/gi,
    fakeValues: ['postgresql://user:pass@localhost:5432/db'],
  },
  {
    id: 'sql_password',
    label: 'SQL Password',
    cat: 'cred',
    // SQL DDL auth clauses that delimit the secret with a SPACE (not `=`), so
    // the `env_secret` pattern (which requires `[:=]`) never sees them:
    //   CREATE USER app IDENTIFIED BY 'S3cret!';                  -- Oracle / MySQL
    //   CREATE ROLE app WITH PASSWORD 'S3cret!';                  -- PostgreSQL
    //   CREATE USER app IDENTIFIED WITH mysql_native_password BY 'S3cret!';  -- MySQL 8
    //   ALTER USER app IDENTIFIED BY PASSWORD '*HASH...';         -- MySQL legacy hash
    //   ... ENCRYPTED BY 'keymaterial'                            -- Oracle TDE
    // The keyword is matched and ONLY the quoted value (group 1) is masked,
    // leaving the surrounding statement readable. The `=` forms
    // (e.g. SQL Server `WITH PASSWORD = '...'`, ADO `Password=...;`) are
    // intentionally left to `env_secret` so the two patterns never overlap.
    //
    // This used to be a lookbehind with unbounded `\s+`: at every position of
    // a long run of whitespace the engine walked back through the whole run
    // looking for the keyword, so 32 KB of spaces took seconds and 64 KB timed
    // out (#38). Consuming the keyword, with bounded gaps, is linear.
    rx: /\b(?:IDENTIFIED(?:\s{1,20}WITH\s{1,20}[\w.]{1,64})?\s{1,20}BY|PASSWORD|ENCRYPTED\s{1,20}BY)\s{1,20}(?:PASSWORD\s{1,20})?('[^'\n]*'|"[^"\n]*"|`[^`\n]*`)/gi,
    valueGroups: [1],
    fakeValues: ["'P@ssw0rd!'"],
  },
  {
    id: 'databricks_token',
    label: 'Databricks Token',
    labelAr: 'رمز Databricks',
    cat: 'cred',
    rx: /\bdapi[a-fA-F0-9]{32,}(?:-\d+)?\b/g,
    fakeValues: ['dapi1234567890abcdef1234567890abcdef'],
  },
  {
    id: 'databricks_host',
    label: 'Databricks Host',
    labelAr: 'مضيف Databricks',
    cat: 'cred',
    rx: /\bhttps?:\/\/[A-Za-z0-9-]+\.(?:cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com)[^\s"'<>]*/gi,
    fakeValues: ['https://example.cloud.databricks.com'],
  },
  {
    id: 's3_uri',
    label: 'S3 URI',
    labelAr: 'رابط S3',
    cat: 'cred',
    rx: /\bs3:\/\/[A-Za-z0-9._\-]+(?:\/[^\s"'<>]*)?/g,
    fakeValues: ['s3://example-bucket/path'],
  },
  {
    id: 'azure_storage_key',
    label: 'Azure Storage Key',
    labelAr: 'مفتاح تخزين Azure',
    cat: 'cred',
    // The account key or shared access key inside an Azure connection string:
    // `...;AccountName=acct;AccountKey=<base64>;EndpointSuffix=...`. Only the
    // key is replaced, so the connection string stays readable.
    rx: /\b(?:AccountKey|SharedAccessKey)[ \t]*=[ \t]*([A-Za-z0-9+/]{20,}={0,2})/g,
    valueGroups: [1],
    fakeValues: ['EXAMPLEplaceholderNOTAREALKEY'.padEnd(86, '0') + '=='],
  },
  {
    id: 'aws_secret',
    label: 'AWS Secret Key',
    labelAr: 'مفتاح AWS السري',
    cat: 'cred',
    // A secret access key is 40 characters of base64 with nothing to mark it,
    // so it counts only near an access key id or an AWS / secret-access-key
    // label -- the credentials CSV the console downloads puts it right after
    // the key id, with the header on the line above.
    rx: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g,
    validate: (match, text, idx) => /[A-Z]/.test(match) && /[a-z]/.test(match) && /\d/.test(match)
      && !/^\/|\/$|\/\//.test(match)
      && AWS_SECRET_CUE_RX.test(text.slice(Math.max(0, idx - 200), idx)),
    fakeValues: ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  },
  {
    id: 'env_secret',
    label: 'Env Secret',
    labelAr: 'سر بيئي',
    cat: 'cred',
    // Match KEY=VALUE assignments where KEY contains any sensitive substring,
    // covering shell .env (`KEY=value`) and source-code styles
    // (`KEY = "value"`, `KEY: 'value'`). Lookbehind avoids consuming the
    // leading newline that previously collapsed adjacent lines.
    // The prefix before the keyword is OPTIONAL. It used to be mandatory
    // (`[A-Za-z_][\w.-]*` with no `?`), which meant the most common forms in a
    // real .env file were silently missed — `PASSWORD=`, `API_KEY=`, `TOKEN=`,
    // `SECRET=` all failed while `DB_PASSWORD=` matched. The pattern's own
    // fakeValue (`API_KEY=sk-fake123`) was itself undetectable.
    //
    // Three forms, one pattern:
    //   A. `KEY=value`, `KEY: value`, and the same with the key quoted, which is
    //      how JSON, Python and JS objects write it (`{"password": "..."}`),
    //      prefixed by `$` (PHP, shell) or `--` (command-line flags), or inside
    //      Markdown inline code (`` `API_KEY=...` ``).
    //   B. XML elements: `<password>...</password>`.
    //   C. XML / .NET config attributes: `<add key="ApiKey" value="..."/>`.
    // Form A's key used to have to follow whitespace or `,;({[`, so every quoted
    // key -- appsettings.json, credentials.json, Python dicts -- was missed.
    rx: new RegExp(
      `(?<=^|[\\s,;({\\[$"'\`-])(${SECRET_KEY})["']?[ \\t]*[:=][ \\t]*(?:"([^"\\n]+)"|'([^'\\n]+)'|([^\\s\\n#,;)\\]}"'\`]+))`
      + `|<(${SECRET_KEY})(?:[ \\t][^>\\n]*)?>([^<\\n]{1,256})<\\/\\5>`
      + `|\\b(?:key|name)[ \\t]*=[ \\t]*["'](${SECRET_KEY})["'][ \\t]+value[ \\t]*=[ \\t]*["']([^"'\\n]+)["']`,
      'gim',
    ),
    // Keys that contain a trigger word but never hold a secret, and values that
    // are not secrets. Kept short and specific on purpose: for a DLP tool,
    // over-masking a benign value is a nuisance while missing a real `TOKEN=` is
    // a breach, so the default leans toward detection and this list stays an
    // explicit, auditable exception.
    validate: (match) => {
      const { key, value, keyQuoted, valueQuoted } = splitSecretAssignment(match);
      if (/^(?:[\w.-]*_)?TOKENIZ(?:E|ER|ERS|ATION)$/i.test(key)) return false;
      if (!value) return false;
      // JSON has no bare strings, so a bare value after a quoted key is code:
      // `{"X-Signature": HMAC_SECRET}` references a variable, it is not one.
      if (keyQuoted && !valueQuoted) return false;
      // Never re-detect a token this masker already emitted. Now that only the
      // VALUE is replaced, `API_KEY=[OPENAI_KEY_1]` still looks like KEY=value
      // -- so without this, masking stopped being idempotent and the Guardian's
      // verifier could never converge (it re-scans its own output and would
      // escalate forever, ending in BLOCK).
      if (/^\[[A-Z0-9_]*\]?$/.test(value)) return false;
      // JSON makes these common: `"password": null`, `"token": {` (an object).
      if (/^(?:null|undefined|none|nil|true|false)$/i.test(value)) return false;
      if (/^[{[]/.test(value)) return false;
      // A key that describes a property of a secret, not the secret itself:
      // `max_tokens: 1024`, `token_type: bearer`, `PASSWORD_MIN_LENGTH=12`.
      if (describesSecretProperty(key)) return false;
      // A reference or placeholder, not a value: `${DB_PASSWORD}`, `$TOKEN`,
      // `{{ secrets.KEY }}`, `%(password)s`, `<your-key>`, `sk-proj-...`.
      if (SECRET_PLACEHOLDER_RX.test(value)) return false;
      // A loopback host is not infrastructure worth hiding.
      if (/host/i.test(key) && LOCAL_HOST_RX.test(value)) return false;
      return true;
    },
    // Replace the VALUE only -- form A: group 2 double-quoted, 3 single-quoted,
    // 4 bare; form B: 6; form C: 8 -- never the whole `KEY=value`. Masking the
    // key name too turned `OPENAI_API_KEY=sk-...` into a bare `[ENV_SECRET_1]`,
    // which destroys the one piece of context an agent needs to reason about
    // the file -- and it shadowed the specific credential patterns, so the
    // `[OPENAI_KEY_1]` token this project's own README advertises could never
    // actually appear. Narrowing the span also lets a more specific pattern win
    // the overlap.
    valueGroups: [2, 3, 4, 6, 8],
  },
  {
    id: 'hex_secret',
    label: 'Hex Secret',
    labelAr: 'سر Hex',
    cat: 'cred',
    rx: /\b[a-fA-F0-9]{32,}\b/g,
    // A git commit is 40 hex characters and a SHA-256 checksum 64, so without
    // context every changelog, lockfile and CI log read as a credential -- and
    // the Guardian then demanded human approval for a harmless file.
    // 32 to 39 characters is also an MD5, a UUID without dashes or a request
    // id, so a key that short counts only after a key word on its line
    // (`api_key: 5d41...`, `X-Api-Token: ...`).
    validate: (match, text, idx) => /[a-fA-F]/.test(match)
      && (match.length >= 40 || HEX_SECRET_CUE_RX.test(linePrefix(text, idx, 48)))
      && !looksLikeHashReference(match, text, idx),
    fakeValues: ['a1b2c3d4e5f6789012345678901234567890abcd'],
  },
];

const PATTERNS = [...BASE_PATTERNS];

const ID_PATTERNS = PATTERNS.filter((p) => p.cat === 'id');
const PII_PATTERNS = PATTERNS.filter((p) => p.cat === 'pii');
const CRED_PATTERNS = PATTERNS.filter((p) => p.cat === 'cred');

module.exports = {
  PATTERNS,
  BASE_PATTERNS,
  ID_PATTERNS,
  PII_PATTERNS,
  CRED_PATTERNS,
  NAME_STOPLIST,
  // Precision gating for the name patterns — exported so tests and future
  // tuning can reach them without re-deriving the lists.
  COMMON_EN,
  COMMON_AR,
  AR_NAME_PARTICLES,
  NAME_CUE_RX,
  looksLikeName,
  isOrgOrPlace,
  // Checksum helpers — used by the reporter (A2) and PDPL mapping (A5) to
  // badge findings as "checksum-verified" without breaking pattern lenience.
  luhnCheck,
  isValidEmiratesId,
  isValidIban,
};
