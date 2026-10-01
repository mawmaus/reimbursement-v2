'use strict';

// Verifies the "What's new" release notes are complete in every UI language.
//   node scripts/check-changelog.js
// Fails (exit 1) when a release item is missing a language or names an unknown
// audience, a release id is duplicated or out of order, or the modal's own
// labels lack a translation.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pub = path.join(__dirname, '..', 'public');
const sandbox = {
  window: {},
  localStorage: { getItem() { return null; }, setItem() {} },
  document: { documentElement: { setAttribute() {} } }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(pub, 'i18n.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(pub, 'changelog.js'), 'utf8'), sandbox);

const { I18N, CHANGELOG } = sandbox.window;
const langs = I18N.LANGS.map(l => l.code);
const KINDS = ['new', 'improved', 'fixed'];
const UI_KEYS = ["What's new", 'New', 'Improved', 'Fixed', 'Latest', 'Recent changes and improvements to the portal.', 'Close'];
const errors = [];

// Audience keys: declared in changelog.js, and each must have a matcher in
// app.js's NOTE_AUDIENCE, or the item would silently show to nobody.
const AUDIENCES = sandbox.window.CHANGELOG_AUDIENCES || [];
const appSrc = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const matcherBlock = (appSrc.match(/const NOTE_AUDIENCE = \{([\s\S]*?)\n\};/) || [])[1] || '';
const matchers = new Set([...matcherBlock.matchAll(/^\s*(\w+):/gm)].map(m => m[1]));
for (const k of AUDIENCES) if (!matchers.has(k)) errors.push(`app.js NOTE_AUDIENCE has no matcher for audience "${k}"`);

if (!Array.isArray(CHANGELOG) || !CHANGELOG.length) errors.push('window.CHANGELOG is empty or missing');
const ids = new Set();
let prev = null;
(CHANGELOG || []).forEach((r, ri) => {
  const where = `release ${r.id || '#' + ri}`;
  if (!r.id) errors.push(`${where}: missing id`);
  else if (ids.has(r.id)) errors.push(`${where}: duplicate id`);
  ids.add(r.id);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) errors.push(`${where}: date must be YYYY-MM-DD`);
  else if (prev && r.date > prev) errors.push(`${where}: releases must be newest first`);
  prev = r.date || prev;
  if (!Array.isArray(r.items) || !r.items.length) errors.push(`${where}: no items`);
  (r.items || []).forEach((it, ii) => {
    if (!KINDS.includes(it.kind)) errors.push(`${where} item ${ii + 1}: kind must be one of ${KINDS.join('/')}`);
    if (it.audience !== undefined) {
      if (!Array.isArray(it.audience) || !it.audience.length) errors.push(`${where} item ${ii + 1}: audience must be a non-empty array (or left off for everyone)`);
      else for (const k of it.audience) if (!AUDIENCES.includes(k)) errors.push(`${where} item ${ii + 1}: unknown audience "${k}"`);
    }
    for (const l of langs) {
      const s = it.text && it.text[l];
      if (typeof s !== 'string' || !s.trim()) errors.push(`${where} item ${ii + 1}: missing "${l}" text`);
    }
  });
});

// The modal's labels must be in every non-English dictionary (English is the key).
for (const l of langs.filter(c => c !== 'en')) {
  I18N.setLangLocal(l);
  for (const k of UI_KEYS) if (I18N.t(k) === k) errors.push(`i18n.js: "${k}" has no "${l}" translation`);
}

if (errors.length) {
  console.error(`What's new check failed (${errors.length}):\n  - ` + errors.join('\n  - '));
  process.exit(1);
}
console.log(`What's new OK: ${CHANGELOG.length} releases, all in ${langs.join(', ')}.`);
