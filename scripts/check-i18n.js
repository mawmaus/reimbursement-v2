'use strict';

// Verifies the UI translations are complete and carry no dead weight.
//   node scripts/check-i18n.js        (npm run check:i18n)
// Runs in the Vercel build (vercel.json), before stamp-assets minifies public/,
// so a failure here blocks the deploy.
// The language tables (public/i18n/<code>.js) are keyed by English source text.
// Fails (exit 1) when:
//  - missing: a string the UI shows has no entry in some language. Counted as
//    shown: t('…') literals and data-i18n* attributes in the client, plus every
//    sentence-like literal in the server (app.js, routes/, lib/) — those are the
//    error messages api() runs through t() before they reach the screen;
//  - dead: a key whose English text appears nowhere in the client or server
//    code any more (reworded or removed strings);
//  - the languages disagree on their key set, a value is blank, or a value
//    drops/invents a {placeholder} its key has.
// Server text that is never shown in the UI (emails, history notes, operator
// messages) is listed in SERVER_IGNORE below.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');
const rel = f => path.relative(root, f).replace(/\\/g, '/');
const listJs = dir => fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => path.join(dir, f));

// --- language tables --------------------------------------------------------
const dicts = {};
const sandbox = { I18N: { addDict(code, d) { dicts[code] = d; } } };
vm.createContext(sandbox);
for (const f of listJs(path.join(pub, 'i18n'))) vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: f });
const langs = Object.keys(dicts);

// --- sources ----------------------------------------------------------------
const clientFiles = [
  ...fs.readdirSync(pub).filter(f => /\.(js|html)$/.test(f)).map(f => path.join(pub, f)),
  ...listJs(path.join(pub, 'js'))
];
const serverFiles = [path.join(root, 'app.js'), ...listJs(path.join(root, 'routes')), ...listJs(path.join(root, 'lib'))];
const read = f => fs.readFileSync(f, 'utf8');
const clientSrc = clientFiles.map(read).join('\n');
const serverSrc = serverFiles.map(read).join('\n');

// Server files / strings that never reach the UI.
const SERVER_IGNORE_FILES = new Set(['lib/notify.js', 'lib/email.js']);
const SERVER_IGNORE = new Set([
  'Reset your password', 'Reset your Reimbursement Portal password',                  // reset email
  'Reimbursement Portal — test email', 'Test email',                                   // test email
  'This is a test email from the Reimbursement Portal. If you received it, email delivery is working correctly.',
  'Reverted by the claimant to make changes',                                          // history note
  'CibesReimbursement/1.0 (reimbursement receipt stamping)',                           // HTTP User-Agent
  'A file',                                                                            // fragment of a templated message
  'Private receipt storage is not configured (PRIVATE_READ_WRITE_TOKEN / PRIVATE_STORE_ID is missing)' // 500, logged only
]);

const unescape = s => s.replace(/\\(['"`\\])/g, '$1');

// Strings the UI shows: t() literals and data-i18n* attributes.
const shown = new Map(); // key -> first place it was seen
const see = (k, where) => { if (!shown.has(k)) shown.set(k, where); };
for (const f of clientFiles) {
  const src = read(f);
  for (const m of src.matchAll(/(?<![\w.$])t\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g)) see(unescape(m[1] ?? m[2]), rel(f));
  for (const m of src.matchAll(/data-i18n(?:-[a-z]+)?="([^"]*)"/g)) see(m[1].replace(/&amp;/g, '&'), rel(f));
}
// Sentence-like server literals: a capitalised word followed by more words, on a
// line that is not a comment or console call, and not SQL.
const LIT = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.)*)`/g;
for (const f of serverFiles) {
  if (SERVER_IGNORE_FILES.has(rel(f))) continue;
  read(f).split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line) || /console\./.test(line)) return;
    for (const m of line.matchAll(LIT)) {
      const s = unescape(m[1] ?? m[2] ?? m[3]);
      if (!/^[A-Z](?:[a-z]| [a-z])/.test(s) || !/ [a-z]/.test(s) || /\b(SELECT|UPDATE|INSERT|DELETE|WHERE|FROM)\b/.test(s)) continue;
      if (!SERVER_IGNORE.has(s)) see(s, `${rel(f)}:${i + 1}`);
    }
  });
}

// A key is alive if shown, or if its English text sits anywhere in the code as
// a string literal (keys reached indirectly, e.g. t(tab.label)).
const allSrc = clientSrc + '\n' + serverSrc;
const literalForms = k => [`'${k.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`, `"${k.replace(/"/g, '\\"')}"`, `\`${k}\``, `"${k.replace(/&/g, '&amp;')}"`];
const alive = k => shown.has(k) || literalForms(k).some(f => allSrc.includes(f));

// --- checks -----------------------------------------------------------------
const problems = [];
const placeholders = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

for (const [k, where] of shown) {
  const lacking = langs.filter(l => !(k in dicts[l]));
  if (lacking.length) problems.push(`missing [${lacking.join(',')}] ${JSON.stringify(k)}  (${where})`);
}
const allKeys = new Set(langs.flatMap(l => Object.keys(dicts[l])));
for (const k of allKeys) {
  if (!alive(k)) problems.push(`dead ${JSON.stringify(k)}  (not in the code any more — remove it from every language)`);
  for (const l of langs) {
    if (!(k in dicts[l])) { if (!shown.has(k)) problems.push(`missing [${l}] ${JSON.stringify(k)}  (other languages have it)`); continue; }
    const v = dicts[l][k];
    // '' is deliberate (it hides the text in that language, e.g. Indonesian's
    // "Dalam kota" subtitle under a label that already says it); whitespace isn't.
    if (typeof v !== 'string' || (v && !v.trim())) problems.push(`empty [${l}] ${JSON.stringify(k)}`);
    else if (v && placeholders(v) !== placeholders(k)) problems.push(`placeholders [${l}] ${JSON.stringify(k)}: {${placeholders(k)}} vs {${placeholders(v)}}`);
  }
}

if (problems.length) {
  console.error(`Translations: ${problems.length} problem(s)\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log(`Translations OK: ${allKeys.size} keys in ${langs.join(', ')}; ${shown.size} UI strings covered.`);
