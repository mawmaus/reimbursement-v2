'use strict';

// The hand-rolled .xlsx writer behind the claims export: the zip must unpack,
// and cells must come out typed (numbers / dates) or as escaped text.

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { buildXlsx, colName, serial } = require('../lib/xlsx');

// Read every entry of a zip via its central directory.
function unzip(buf) {
  const files = {};
  let p = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(p >= 0, 'end-of-central-directory record');
  const count = buf.readUInt16LE(p + 10);
  let c = buf.readUInt32LE(p + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(c), 0x02014b50);
    const size = buf.readUInt32LE(c + 20), nameLen = buf.readUInt16LE(c + 28);
    const extra = buf.readUInt16LE(c + 30), comment = buf.readUInt16LE(c + 32);
    const off = buf.readUInt32LE(c + 42);
    const name = buf.toString('utf8', c + 46, c + 46 + nameLen);
    const lhName = buf.readUInt16LE(off + 26), lhExtra = buf.readUInt16LE(off + 28);
    const start = off + 30 + lhName + lhExtra;
    files[name] = zlib.inflateRawSync(buf.subarray(start, start + size)).toString('utf8');
    c += 46 + nameLen + extra + comment;
  }
  return files;
}

test('column names and Excel date serials', () => {
  assert.deepEqual([0, 25, 26, 51, 52].map(colName), ['A', 'Z', 'AA', 'AZ', 'BA']);
  assert.equal(serial('2026-10-23', false), 46318);
  assert.equal(serial('2026-10-23 18:00:00', true), 46318.75);
  assert.equal(serial('2026-10-23 18:00:00', false), 46318, 'a date column drops the time');
  assert.equal(serial('not a date', false), null);
});

test('builds a workbook with typed, escaped cells', () => {
  const buf = buildXlsx({
    sheetName: 'Claims',
    columns: [
      { header: 'Name', type: 'text' }, { header: 'Amount', type: 'money' },
      { header: 'Date', type: 'date' }, { header: 'At', type: 'datetime' }
    ],
    rows: [
      ['A & B <x> "q"', '1234.50', '2026-10-23', '2026-10-23 06:30:00'],
      ['Bad\u0001char', 'n/a', '', null]
    ]
  });
  const files = unzip(buf);
  for (const n of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
    'xl/styles.xml', 'xl/worksheets/sheet1.xml']) assert.ok(files[n], n);
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">A &amp; B &lt;x&gt; &quot;q&quot;<\/t>/);
  assert.match(sheet, /<c r="B2" s="2"><v>1234.5<\/v><\/c>/, 'money is a number');
  assert.match(sheet, /<c r="C2" s="3"><v>46318<\/v><\/c>/, 'date is a serial');
  assert.match(sheet, /<c r="D2" s="4"><v>46318\.27083/, 'datetime keeps its time');
  assert.match(sheet, />Badchar</, 'control characters dropped');
  assert.match(sheet, /<c r="B3" t="inlineStr"><is><t xml:space="preserve">n\/a</, 'unparseable money stays text');
  assert.doesNotMatch(sheet, /r="C3"|r="D3"/, 'blanks stay empty');
  assert.match(sheet, /<autoFilter ref="A1:D3"\/>/);
  assert.match(sheet, /state="frozen"/);
  assert.match(files['xl/workbook.xml'], /<sheet name="Claims"/);
});
