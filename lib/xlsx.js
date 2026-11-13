'use strict';

// Minimal .xlsx writer (and reader) — enough for the claims export and the
// accounts workbook without pulling in a spreadsheet library. Produces a real
// Office Open XML workbook: typed cells (numbers stay numbers, dates are true
// Excel dates), a bold frozen header row with an auto-filter, and sized
// columns. The zip container is built by hand with zlib's raw deflate.
//
// buildXlsx({ sheetName, columns: [{ header, type, width }], rows: [[...]] })
//   type: 'text' (default) | 'money' (#,##0.00) | 'date' ('YYYY-MM-DD')
//         | 'datetime' ('YYYY-MM-DD HH:MM:SS')
//         | 'textfmt' (Excel "Text" format: typed digits stay digits) | 'wrap'
// A money/date cell whose value doesn't parse falls back to text, and blanks
// stay empty, so nothing is ever lost or turned into a bogus 0 / 1900-01-00.
//
// buildWorkbook({ sheets: [{ name, columns, rows, validations, filter }] }) is
// the multi-sheet form: validations = [{ col, source: "Lists!$A$2:$A$9" }] put
// an in-cell dropdown on a column (a warning only, so other values still go in).
// readXlsx(buffer) → [{ name, rows: [[string]] }], every cell as its text.

const zlib = require('zlib');

const xmlEsc = (s) => String(s)
  // Drop control characters XML 1.0 can't carry (Excel refuses the file).
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Column index (0-based) → "A", "B", … "AA".
function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Excel serial day number (1900 date system) for a wall-clock date/time.
const EPOCH_OFFSET = 25569; // days from 1899-12-30 to 1970-01-01
function serial(str, withTime) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(str);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], withTime ? +(m[4] || 0) : 0, withTime ? +(m[5] || 0) : 0, withTime ? +(m[6] || 0) : 0);
  return isNaN(ms) ? null : ms / 86400000 + EPOCH_OFFSET;
}

// Style ids, matching cellXfs in STYLES below.
const S_HEADER = 1, S_MONEY = 2, S_DATE = 3, S_DATETIME = 4, S_TEXT = 5, S_WRAP = 6;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF9AA8BC"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cellXml(ref, v, type) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) v = v.toISOString();
  if (type === 'money') {
    const n = Number(v);
    if (Number.isFinite(n)) return `<c r="${ref}" s="${S_MONEY}"><v>${n}</v></c>`;
  } else if (type === 'date' || type === 'datetime') {
    const n = serial(String(v), type === 'datetime');
    if (n !== null) return `<c r="${ref}" s="${type === 'date' ? S_DATE : S_DATETIME}"><v>${n}</v></c>`;
  }
  const st = type === 'textfmt' ? ` s="${S_TEXT}"` : type === 'wrap' ? ` s="${S_WRAP}"` : '';
  return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
}

function sheetXml(columns, rows, { validations = [], filter = true, validationRows = 1000 } = {}) {
  const last = colName(columns.length - 1);
  // A Text-format column carries the style on the column itself, so cells typed
  // in later (not just the ones written here) keep leading zeros / long digits.
  const cols = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"${c.type === 'textfmt' ? ` style="${S_TEXT}"` : ''}/>`).join('');
  const head = `<row r="1">${columns.map((c, i) =>
    `<c r="${colName(i)}1" t="inlineStr" s="${S_HEADER}"><is><t xml:space="preserve">${xmlEsc(c.header)}</t></is></c>`).join('')}</row>`;
  const body = rows.map((r, ri) => {
    const rn = ri + 2;
    return `<row r="${rn}">${columns.map((c, i) => cellXml(colName(i) + rn, r[i], c.type)).join('')}</row>`;
  }).join('');
  const lastRow = Math.max(validationRows, rows.length + 1);
  const dv = validations.length ? `<dataValidations count="${validations.length}">${validations.map(v =>
    `<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorStyle="warning" sqref="${colName(v.col)}2:${colName(v.col)}${lastRow}"><formula1>${xmlEsc(v.source)}</formula1></dataValidation>`).join('')}</dataValidations>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${last}${rows.length + 1}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${head}${body}</sheetData>
${filter ? `<autoFilter ref="A1:${last}${rows.length + 1}"/>` : ''}${dv}
</worksheet>`;
}

// --- zip container ----------------------------------------------------------
let CRC_TABLE;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  // Fixed DOS timestamp (2000-01-01 00:00): the content, not the mtime, matters.
  const dosTime = 0, dosDate = ((2000 - 1980) << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Sheet names: max 31 chars, none of []:*?/\
const sheetTitle = (n) => String(n).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet1';

function buildWorkbook({ sheets }) {
  const names = sheets.map(sh => sheetTitle(sh.name));
  const filters = sheets.map((sh, i) => sh.filter === false ? '' :
    `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlEsc(names[i]).replace(/'/g, "''")}'!$A$1:$${colName(sh.columns.length - 1)}$${sh.rows.length + 1}</definedName>`).join('');
  return zip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
${filters ? `<definedNames>${filters}</definedNames>` : ''}
</workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: 'xl/styles.xml', data: STYLES },
    ...sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sh.columns, sh.rows, sh) }))
  ]);
}

function buildXlsx({ sheetName = 'Sheet1', columns, rows }) {
  return buildWorkbook({ sheets: [{ name: sheetName, columns, rows }] });
}

// --- reader -----------------------------------------------------------------
// Enough of Office Open XML to read back a workbook that Excel, LibreOffice or
// Google Sheets saved: the zip, the shared strings, and each sheet's cells as
// text. Only the .xml / .rels parts are inflated, with a hard size cap.
const MAX_UNZIPPED = 40 * 1024 * 1024;
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (!/\.(xml|rels)$/i.test(name)) continue;
    total += usize;
    if (total > MAX_UNZIPPED) throw new Error('zip too large');
    const data0 = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(data0, data0 + csize);
    const out = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNZIPPED }) : null;
    if (out) files.set(name.replace(/^\//, ''), out.toString('utf8'));
  }
  return files;
}
const xmlText = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/_x([0-9A-F]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
// The visible text of an <si> / <is>: every <t> run, minus phonetic (<rPh>) hints.
const runText = (xml) => [...String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)]
  .map(m => xmlText(m[1])).join('');
const attr = (tag, name) => { const m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag); return m ? xmlText(m[1]) : ''; };
function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref);
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function readXlsx(buf) {
  const files = unzip(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  const wb = files.get('xl/workbook.xml');
  if (!wb) throw new Error('no workbook');
  const rels = new Map();
  for (const m of (files.get('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)) rels.set(attr(m[0], 'Id'), attr(m[0], 'Target'));
  const shared = [...(files.get('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map(m => runText(m[1] || ''));
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    let target = rels.get(attr(m[0], 'r:id')) || '';
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const xml = files.get(target);
    if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rn = Number(attr(r[1], 'r')) || rows.length + 1;
      if (rn > 100000) break;
      const cells = [];
      let next = 0;
      for (const c of (r[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1], 'r');
        const i = ref ? colIndex(ref) : next;
        next = i + 1;
        if (i < 0 || i > 200) continue;
        const t = attr(c[1], 't');
        const inner = c[2] || '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        let val = '';
        if (t === 'inlineStr') val = runText(inner);
        else if (t === 's') val = v ? (shared[Number(v[1])] ?? '') : '';
        else if (t === 'b') val = v ? (v[1] === '1' ? 'TRUE' : 'FALSE') : '';
        else val = v ? xmlText(v[1]) : '';
        cells[i] = val;
      }
      rows[rn - 1] = Array.from(cells, x => x ?? '');
    }
    sheets.push({ name: attr(m[0], 'name'), rows: Array.from(rows, x => x || []) });
  }
  return sheets;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

module.exports = { buildXlsx, buildWorkbook, readXlsx, XLSX_MIME, colName, serial };
