'use strict';

// Build step (Vercel runs it before serving public/ from its CDN):
//   node scripts/stamp-assets.js [--minify]
// Rewrites each page's local <script src> / <link href> to carry a content hash,
// e.g. app.js -> app.js?v=3f9c1a2b. vercel.json marks ?v= URLs immutable, so a
// browser keeps them for good and only fetches again when the file changes (its
// hash, and so its URL, changes). The pages themselves stay `no-cache`, so a new
// deploy is always picked up on the next load. Idempotent: an existing ?v= is
// replaced. Locally the pages are served unstamped, which is fine.
//
// --minify (the Vercel build only; local files stay readable) first shrinks the
// scripts and stylesheet in place with esbuild, each with a source map beside
// it so browser errors still point at the original code. The scripts are plain
// <script>s sharing globals (t(), the app's functions), and esbuild never
// renames a script's top-level names, only locals. Order matters: the language
// files are minified before their hashes go into i18n.js, and i18n.js after.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pub = path.join(__dirname, '..', 'public');
const MINIFY = process.argv.includes('--minify');

// Minify one file in place (public-relative path), writing <file>.map beside it.
function minify(rel) {
  const esbuild = require('esbuild'); // dev dependency, needed only here
  const file = path.join(pub, rel);
  const src = fs.readFileSync(file, 'utf8');
  const loader = rel.endsWith('.css') ? 'css' : 'js';
  const out = esbuild.transformSync(src, {
    loader, minify: true, sourcemap: 'external', sourcefile: path.basename(rel),
    // Keep Thai/Khmer/Vietnamese text as UTF-8 rather than \u escapes (smaller).
    charset: 'utf8'
  });
  const mapName = path.basename(rel) + '.map';
  const ref = loader === 'css' ? `/*# sourceMappingURL=${mapName} */` : `//# sourceMappingURL=${mapName}`;
  fs.writeFileSync(file, out.code + ref + '\n');
  fs.writeFileSync(file + '.map', out.map);
  return [src.length, out.code.length];
}
function minifyAll(rels) {
  let before = 0, after = 0;
  for (const rel of rels) { const [b, a] = minify(rel); before += b; after += a; }
  console.log(`stamp-assets: minified ${rels.length} file(s), ${(before / 1024) | 0} KB -> ${(after / 1024) | 0} KB`);
}
// Every script and stylesheet we author (vendor/ is already minified).
const authored = (dir = '') => fs.readdirSync(path.join(pub, dir), { withFileTypes: true }).flatMap(d => {
  const rel = path.join(dir, d.name);
  if (d.isDirectory()) return d.name === 'vendor' ? [] : authored(rel);
  return /\.(js|css)$/.test(d.name) ? [rel] : [];
});
const hashes = new Map();
const hashOf = (rel) => {
  if (!hashes.has(rel)) {
    const buf = fs.readFileSync(path.join(pub, rel));
    hashes.set(rel, crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10));
  }
  return hashes.get(rel);
};

// The per-language tables are loaded by i18n.js at runtime, not referenced from
// a page, so their hashes go into i18n.js itself (DICT_VERSIONS). This runs
// first: the pages' hash of i18n.js must cover the stamped content.
const i18nFile = path.join(pub, 'i18n.js');
const dictDir = path.join(pub, 'i18n');
const dictFiles = fs.existsSync(dictDir) ? fs.readdirSync(dictDir).filter(f => f.endsWith('.js')).map(f => path.join('i18n', f)) : [];
if (MINIFY) minifyAll(dictFiles);
if (fs.existsSync(dictDir)) {
  const versions = {};
  for (const f of fs.readdirSync(dictDir).filter(f => f.endsWith('.js')).sort()) {
    versions[f.replace(/\.js$/, '')] = hashOf(path.join('i18n', f));
  }
  const src = fs.readFileSync(i18nFile, 'utf8');
  const out = src.replace(/const DICT_VERSIONS = \{[^}]*\};/, `const DICT_VERSIONS = ${JSON.stringify(versions)};`);
  if (out === src && !src.includes(JSON.stringify(versions))) throw new Error('stamp-assets: DICT_VERSIONS marker not found in i18n.js');
  fs.writeFileSync(i18nFile, out);
  console.log(`stamp-assets: versioned ${Object.keys(versions).length} language file(s)`);
}
// Everything else (i18n.js now that its DICT_VERSIONS is in), before the pages'
// hashes are taken below.
if (MINIFY) minifyAll(authored().filter(rel => !dictFiles.includes(rel)));

let stamped = 0;
for (const page of fs.readdirSync(pub).filter(f => f.endsWith('.html'))) {
  const file = path.join(pub, page);
  const html = fs.readFileSync(file, 'utf8');
  const out = html.replace(/\b(src|href)="([\w./-]+\.(?:js|css))(?:\?v=[\w]+)?"/g, (m, attr, rel) => {
    if (!fs.existsSync(path.join(pub, rel))) return m;
    stamped++;
    return `${attr}="${rel}?v=${hashOf(rel)}"`;
  });
  if (out !== html) fs.writeFileSync(file, out);
}
console.log(`stamp-assets: versioned ${stamped} asset reference(s)`);
