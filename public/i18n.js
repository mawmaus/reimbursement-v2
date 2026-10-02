'use strict';

// ---------------------------------------------------------------------------
// Lightweight i18n layer for the reimbursement portal.
//
// Strings are keyed by their English source text: t('New claim') returns the
// active language's translation, or the English source itself when no entry
// exists (so a missing translation degrades gracefully instead of breaking).
// {placeholders} are substituted from the params object: t('Hi {name}', {name}).
//
// The chosen language becomes the user's default: it is cached in localStorage
// (so it applies instantly and on the login screen, before any account is
// known) and, once signed in, persisted to the account via PUT /api/me so it
// follows them across devices. app.js reconciles the two after /login and /me.
//
// PDF output is intentionally NOT translated here — its embedded Helvetica font
// is Latin-only (see pdfSafe in app.js), so Thai/Khmer/Vietnamese/etc. glyphs
// cannot be drawn into the document.
// ---------------------------------------------------------------------------
(function () {
  // Order defines how the switcher lists them. English is the default and shows
  // no descriptive suffix. The others use the country names the user asked for.
  const LANGS = [
    { code: 'en', label: 'English' },
    { code: 'id', label: 'Indonesia' },
    { code: 'th', label: 'Thailand' },
    { code: 'vi', label: 'Vietnam' },
    { code: 'km', label: 'Cambodia' },
    { code: 'fil', label: 'Philippine' }
  ];
  const CODES = LANGS.map(l => l.code);
  const LS_KEY = 'reimb.lang';

  // Native-name for the option label, so a speaker recognises their language
  // even when the current UI is in another language.
  const NATIVE = { en: 'English', id: 'Bahasa Indonesia', th: 'ไทย', vi: 'Tiếng Việt', km: 'ខ្មែរ', fil: 'Filipino' };

  // Translations live in public/i18n/<code>.js, one file per language, so a
  // browser downloads only the language in use. Each file registers itself via
  // I18N.addDict(code, table); English is the source text and needs no file.
  const DICT = {};
  // Content hashes of those files (cache-busting ?v=), filled in at build time by
  // scripts/stamp-assets.js. Empty locally, where the URLs go unversioned.
  const DICT_VERSIONS = {};

  // Month abbreviations for the Insights trend axis (12-slot arrays).
  const MONTHS = {
    en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    id: ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'],
    th: ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'],
    vi: ['Th1', 'Th2', 'Th3', 'Th4', 'Th5', 'Th6', 'Th7', 'Th8', 'Th9', 'Th10', 'Th11', 'Th12'],
    km: ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'],
    fil: ['Ene', 'Peb', 'Mar', 'Abr', 'May', 'Hun', 'Hul', 'Ago', 'Set', 'Okt', 'Nob', 'Dis']
  };

  // ------------------------------------------------------------------- runtime
  // `current` is the language chosen; `shown` is the one t() renders. They differ
  // only while a newly chosen language's table is still downloading, so the
  // screen stays in the previous language instead of flashing English.
  let current = 'en';
  let shown = 'en';

  const normalize = (code) => CODES.includes(String(code)) ? String(code) : 'en';

  function readCached() {
    try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; }
  }
  function writeCached(code) {
    try { localStorage.setItem(LS_KEY, code); } catch { /* private mode / disabled storage */ }
  }

  // --- Per-language tables, fetched on demand -------------------------------
  const dictUrl = (code) => `/i18n/${code}.js${DICT_VERSIONS[code] ? '?v=' + DICT_VERSIONS[code] : ''}`;
  const requested = {};
  const announce = () => {
    try { window.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang: shown } })); } catch { /* no DOM */ }
  };
  function show(code) {
    shown = code;
    try { document.documentElement.setAttribute('lang', code); } catch { /* pre-DOM */ }
  }
  // Called by each public/i18n/<code>.js. When the chosen language arrives after
  // the page has rendered (a switch, or an account default adopted at sign-in),
  // `i18n:changed` tells app.js to re-translate what is on screen.
  function addDict(code, table) {
    DICT[code] = table;
    if (code === current && shown !== code) { show(code); announce(); }
  }
  // Make sure a language's table is (being) loaded. While the page is still
  // parsing, the script is written in place so it runs before app.js — the first
  // paint is already translated, with no flash of English. Afterwards it is
  // appended and announces itself through addDict.
  function ensureDict(code) {
    if (code === 'en' || DICT[code] || requested[code]) return;
    requested[code] = true;
    try {
      if (document.readyState === 'loading') {
        document.write(`<script src="${dictUrl(code)}"><\/script>`);
        return;
      }
      const s = document.createElement('script');
      s.src = dictUrl(code);
      // A failed fetch keeps the language already on screen (and puts the choice
      // back to it, so the switchers don't claim otherwise); a later switch retries.
      s.onerror = () => {
        requested[code] = false; s.remove();
        if (code === current) { current = shown; writeCached(shown); announce(); }
      };
      document.head.appendChild(s);
    } catch { requested[code] = false; /* no DOM (e.g. scripts/check-changelog.js) */ }
  }

  // Choose a language locally (state + <html lang> + cache). Does NOT touch the
  // server — app.js handles account persistence when a signed-in user switches.
  // Takes effect at once when its table is at hand, else as soon as it loads.
  function setLangLocal(code) {
    current = normalize(code);
    writeCached(current);
    if (current === 'en' || DICT[current]) show(current);
    else ensureDict(current);
  }

  // t(en, params) — translate a source-English string, substituting {tokens}.
  function t(en, params) {
    let s = en;
    const table = DICT[shown];
    if (table && Object.prototype.hasOwnProperty.call(table, en)) s = table[en];
    if (params) {
      s = s.replace(/\{(\w+)\}/g, (m, k) =>
        (params[k] !== undefined && params[k] !== null) ? String(params[k]) : m);
    }
    return s;
  }

  // Localised month abbreviations for the current language.
  function months() { return MONTHS[shown] || MONTHS.en; }

  // Update every element tagged for static translation under `root`.
  //  data-i18n         → textContent
  //  data-i18n-ph      → placeholder attribute
  //  data-i18n-title   → title attribute
  //  data-i18n-aria    → aria-label attribute
  function applyStatic(root) {
    const r = root || document;
    r.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
    r.querySelectorAll('[data-i18n-ph]').forEach(el => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
    r.querySelectorAll('[data-i18n-title]').forEach(el => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
    r.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
  }

  window.I18N = {
    LANGS, NATIVE, t, months,
    getLang: () => current,
    setLangLocal, applyStatic, normalize, addDict,
    cached: readCached
  };
  // Convenience global so app.js can call t(...) directly.
  window.t = t;

  // Initialise from the cached choice immediately (before app.js paints), so the
  // login screen and first render already honour the last language used here.
  setLangLocal(readCached() || 'en');
})();
