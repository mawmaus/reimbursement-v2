'use strict';

// Ticked rows in the list: bulk mark paid / revert / delete, and the claims PDF.
// A plain <script> sharing globals with app.js (loaded after it; see
// index.html). Nothing here runs app code at load beyond wiring listeners —
// js/start.js boots the app once every script is in.

// ---------------------------------------------------------------------------
// Selection + PDF export
// ---------------------------------------------------------------------------
$('#selectAll').addEventListener('change', e => {
  const on = e.target.checked;
  $$('.row-check').forEach(cb => {
    cb.checked = on;
    const key = claimKey(cb.dataset.type, cb.dataset.id);
    if (on) state.selected.add(key); else state.selected.delete(key);
  });
  updateSelectionUI();
});
$('#clearSelBtn').addEventListener('click', () => {
  state.selected.clear();
  $$('.row-check').forEach(cb => { cb.checked = false; });
  updateSelectionUI();
});
$('#genPdfBtn').addEventListener('click', generatePdf);
$('#deleteSelBtn').addEventListener('click', deleteSelected);
$('#markPaidSelBtn').addEventListener('click', markPaidSelected);
$('#revertPaidSelBtn').addEventListener('click', revertPaidSelected);

// Bulk revert payment — only paid claims are eligible; each goes back to
// Approved. Confirm once, then revert them all (no date needed).
async function revertPaidSelected() {
  const chosen = state.claims.filter(c => state.selected.has(claimKey(c.type, c.id)));
  const paid = chosen.filter(c => c.status === 'paid');
  if (!paid.length) {
    toast(t('Only paid claims can have their payment reverted — none of the selected are paid.'), true);
    return;
  }
  const n = paid.length;
  const skipped = chosen.length - n;
  let msg = n === 1 ? t('Revert payment on 1 claim? It will go back to Approved.')
                    : t('Revert payment on {n} claims? They will go back to Approved.', { n });
  if (skipped) msg += '\n' + t('{n} selected not paid and will be skipped.', { n: skipped });
  if (!confirm(msg)) return;
  const btn = $('#revertPaidSelBtn'); const orig = btn.textContent;
  btn.disabled = true; btn.textContent = t('Reverting…');
  try {
    // One request walks the whole selection back in a single transaction; the
    // server reports how many were still paid and actually moved.
    const items = paid.map(c => ({
      type: c.type === 'meal' ? 'meal' : c.type === 'advance' ? 'advance' : 'claim',
      id: c.id
    }));
    const { reverted } = await api('/claims/revert-paid-bulk', {
      method: 'POST', body: JSON.stringify({ items })
    });
    state.selected.clear();
    toast(reverted === 1 ? t('Reverted 1 payment') : t('Reverted {n} payments', { n: reverted }));
    loadAll();
  } catch (ex) { toast(ex.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
}

// Bulk mark-paid — only approved claims are eligible; a payment date must be
// chosen (in the modal) before any claim is marked paid.
function markPaidSelected() {
  const chosen = state.claims.filter(c => state.selected.has(claimKey(c.type, c.id)));
  const approved = chosen.filter(c => c.status === 'approved');
  if (!approved.length) {
    toast(t('Only approved claims can be marked as paid — none of the selected are approved.'), true);
    return;
  }
  openBulkPaidModal(approved, chosen.length);
}

// Choose one payment date, then mark every eligible (approved) selected claim
// paid with it. The confirm button stays disabled until a date is present.
function openBulkPaidModal(claims, totalSelected) {
  const today = todayWIB();
  const n = claims.length;
  const skipped = totalSelected - n;
  openModal(`
    <div class="modal-head"><h2>${esc(n === 1 ? t('Mark 1 claim as paid') : t('Mark {n} claims as paid', { n }))}</h2><button class="x-btn">×</button></div>
    <div class="modal-body">
      <form id="bulkPaidForm" class="form">
        <label>${esc(t('Payment date'))}
          <input type="date" name="payment_date" value="${today}" max="${today}" required /></label>
        <p class="muted" style="margin:2px 0 0;font-size:.85rem">${esc(t('The date the payment was actually made. Applied to all selected claims.'))}</p>
        ${skipped ? `<p class="muted" style="margin:8px 0 0;font-size:.85rem">${esc(t('{n} selected not approved and will be skipped.', { n: skipped }))}</p>` : ''}
        <p class="form-error" id="bulkPaidErr" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="bulkPaidCancel">${esc(t('Cancel'))}</button>
          <button type="submit" class="btn btn-primary" id="bulkPaidConfirm">${esc(t('Mark as paid'))}</button>
        </div>
      </form>
    </div>`);
  const dateEl = $('#bulkPaidForm [name="payment_date"]');
  const confirmBtn = $('#bulkPaidConfirm');
  const sync = () => { confirmBtn.disabled = !dateEl.value; };
  dateEl.addEventListener('input', sync); sync();
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#bulkPaidCancel').addEventListener('click', closeModal);
  $('#bulkPaidForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payment_date = dateEl.value;
    if (!payment_date) return;
    confirmBtn.disabled = true; confirmBtn.textContent = t('Marking…');
    try {
      // One request settles the whole selection in a single transaction; the
      // server reports how many were actually eligible to move.
      const items = claims.map(c => ({
        type: c.type === 'meal' ? 'meal' : c.type === 'advance' ? 'advance' : 'claim',
        id: c.id
      }));
      const { paid } = await api('/claims/mark-paid-bulk', {
        method: 'POST', body: JSON.stringify({ items, payment_date })
      });
      state.selected.clear();
      toast(paid === 1 ? t('Marked 1 claim as paid') : t('Marked {n} claims as paid', { n: paid }));
      closeModal(); loadAll();
    } catch (ex) {
      const el = $('#bulkPaidErr'); el.textContent = ex.message; el.hidden = false;
      confirmBtn.disabled = false; confirmBtn.textContent = t('Mark as paid');
    }
  });
}

// Super-admin bulk delete — permanently removes the ticked claims (both types).
async function deleteSelected() {
  const chosen = state.claims.filter(c => state.selected.has(claimKey(c.type, c.id)));
  if (!chosen.length) return;
  const dn = chosen.length;
  if (!confirm(dn === 1 ? t('Permanently delete {n} claim? This cannot be undone.', { n: dn })
    : t('Permanently delete {n} claims? This cannot be undone.', { n: dn }))) return;
  const btn = $('#deleteSelBtn'); const orig = btn.textContent;
  btn.disabled = true; btn.textContent = t('Deleting…');
  try {
    for (const c of chosen) {
      const path = c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
      await api(path + c.id, { method: 'DELETE' });
    }
    state.selected.clear();
    toast(dn === 1 ? t('Deleted {n} claim', { n: dn }) : t('Deleted {n} claims', { n: dn }));
    loadAll();
  } catch (ex) { toast(ex.message, true); }
  finally { btn.disabled = false; btn.textContent = orig; }
}

// Run fn over items with at most `limit` in flight at once, returning results
// in the original order. Used to overlap the network round-trips the PDF export
// needs, instead of queuing them one behind the other.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function generatePdf() {
  const chosen = state.claims.filter(c => state.selected.has(claimKey(c.type, c.id)));
  if (!chosen.length) return;
  const btn = $('#genPdfBtn'); const orig = btn.textContent;
  btn.disabled = true; btn.textContent = t('Preparing…');
  try {
    // Pull full details (approvers, history, attachment list) for each claim —
    // the requests overlap, but the selection's order is preserved.
    const detailed = await mapLimit(chosen, 6, async (c) => {
      const path = c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
      const { claim } = await api(path + c.id);
      claim.type = c.type;
      return claim;
    });
    const bytes = await buildClaimsPdf(detailed);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = detailed.length === 1
      ? `${detailed[0].claim_no}.pdf`
      : `claims-${todayWIB()}.pdf`; // today in the region zone, not UTC
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(detailed.length === 1 ? t('PDF ready — {n} claim', { n: detailed.length }) : t('PDF ready — {n} claims', { n: detailed.length }));
  } catch (ex) {
    toast(ex.message || t('Could not generate PDF'), true);
  } finally { btn.disabled = false; btn.textContent = orig; }
}

// --- PDF engine (pdf-lib, lazily loaded from the vendored bundle) -------------
let _pdfLibPromise;
function loadPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = new Promise((resolve, reject) => {
    if (window.PDFLib) return resolve(window.PDFLib);
    const s = document.createElement('script');
    s.src = 'vendor/pdf-lib.min.js';
    s.onload = () => resolve(window.PDFLib);
    s.onerror = () => reject(new Error('Could not load the PDF engine'));
    document.head.appendChild(s);
  });
  return _pdfLibPromise;
}

// --- HEIC decoder (heic2any, lazily loaded from the vendored bundle) ----------
// iPhones save photos as HEIC, which browsers can't draw to a canvas. We only
// pull in the ~1.3 MB decoder when someone actually uploads one.
let _heicPromise;
function loadHeic2any() {
  if (!_heicPromise) _heicPromise = new Promise((resolve, reject) => {
    if (window.heic2any) return resolve(window.heic2any);
    const s = document.createElement('script');
    s.src = 'vendor/heic2any.min.js';
    s.onload = () => resolve(window.heic2any);
    s.onerror = () => reject(new Error('Could not load the HEIC decoder'));
    document.head.appendChild(s);
  });
  return _heicPromise;
}

function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.split(',')[1]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// Rasterise the brand SVG to PNG bytes once, so the header logo is crisp.
let _logoPngPromise;
function getLogoPngBytes() {
  if (!_logoPngPromise) _logoPngPromise = (async () => {
    const svg = await (await fetch('logo.svg')).text();
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = () => rej(new Error('logo'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
    const W = 631, H = 213, scale = 4;
    const cnv = document.createElement('canvas');
    cnv.width = W * scale; cnv.height = H * scale;
    cnv.getContext('2d').drawImage(img, 0, 0, W * scale, H * scale);
    return dataUrlToBytes(cnv.toDataURL('image/png'));
  })();
  return _logoPngPromise;
}

// Decode any browser-supported image (jpg/png/gif/webp/heic) to PNG bytes so a
// single embed path covers every attachment image type.
async function rasterToPng(bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('decode')); img.src = url; });
    const cnv = document.createElement('canvas');
    cnv.width = img.naturalWidth || img.width; cnv.height = img.naturalHeight || img.height;
    cnv.getContext('2d').drawImage(img, 0, 0);
    return { w: cnv.width, h: cnv.height, bytes: dataUrlToBytes(cnv.toDataURL('image/png')) };
  } finally { URL.revokeObjectURL(url); }
}

// Wrap a picked image in a one-page PDF so a cash-advance request only ever
// carries PDFs (see processAdvanceDocs). The page is A4 in whichever
// orientation matches the photo and the image is scaled to fit inside a small
// margin, so nothing is cropped and the result prints cleanly. A JPEG is
// embedded byte-for-byte — no re-encode, so the file barely grows; anything
// else is rasterised to PNG first, which covers png/webp/gif and whatever the
// browser can decode. Returns a new File named "<original>.pdf".
async function imageToPdfFile(file) {
  const { PDFDocument } = await loadPdfLib();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await PDFDocument.create();
  const img = /^image\/jpe?g$/i.test(file.type || '')
    ? await pdf.embedJpg(bytes)
    : await pdf.embedPng((await rasterToPng(bytes, file.type)).bytes);
  const A_LONG = 841.89, A_SHORT = 595.28, MARGIN = 18;
  const landscape = img.width > img.height;
  const pw = landscape ? A_LONG : A_SHORT;
  const ph = landscape ? A_SHORT : A_LONG;
  const page = pdf.addPage([pw, ph]);
  const s = Math.min((pw - 2 * MARGIN) / img.width, (ph - 2 * MARGIN) / img.height);
  const w = img.width * s, h = img.height * s;
  page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  const out = await pdf.save();
  const name = file.name.replace(/\.[^.]+$/, '') + '.pdf';
  return new File([out], name, { type: 'application/pdf', lastModified: Date.now() });
}

// Helvetica is WinAnsi-only; drop anything it can't encode and normalise the
// few smart-punctuation characters that show up in names/comments.
function pdfSafe(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/—/g, '-').replace(/…/g, '...').replace(/·/g, '-')
    .replace(/[^\x20-\xFF]/g, '');
}

async function buildClaimsPdf(claims) {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let logo = null;
  try { logo = await pdf.embedPng(await getLogoPngBytes()); } catch { /* header falls back to text */ }

  const W = 595.28, H = 841.89, M = 48, CW = W - 2 * M;
  const ink = rgb(0.13, 0.13, 0.14), muted = rgb(0.5, 0.5, 0.55), rule = rgb(0.86, 0.86, 0.84);
  const orange = rgb(0.969, 0.596, 0.165);
  const stColor = {
    submitted: rgb(0.71, 0.47, 0.10), approved: rgb(0.18, 0.49, 0.33), rejected: rgb(0.75, 0.22, 0.17),
    paid: rgb(0.25, 0.35, 0.59), done: rgb(0.18, 0.49, 0.33), current: rgb(0.71, 0.47, 0.10), pending: muted
  };
  let page, y;
  const newPage = () => { page = pdf.addPage([W, H]); y = H - M; };
  const need = (h) => { if (y - h < M) newPage(); };
  const wrap = (s, size, f, maxW) => {
    const words = pdfSafe(s).split(/\s+/); const out = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (f.widthOfTextAtSize(t, size) > maxW && cur) { out.push(cur); cur = w; } else cur = t;
    }
    if (cur) out.push(cur); return out.length ? out : [''];
  };
  const line = (s, { x = M, size = 10, f = font, color = ink, gap = 5 } = {}) => {
    need(size + gap); y -= size; page.drawText(pdfSafe(s), { x, y, size, font: f, color }); y -= gap;
  };
  const section = (s) => { need(24); y -= 16; page.drawText(pdfSafe(s.toUpperCase()), { x: M, y, size: 8, font: bold, color: muted }); y -= 10; };
  // Two-column key/value row (v2/l2 optional).
  const kvRow = (l1, v1, l2, v2) => {
    need(20); y -= 11;
    page.drawText(pdfSafe(l1), { x: M, y, size: 8, font, color: muted });
    page.drawText(pdfSafe(v1 || '-'), { x: M + 84, y, size: 10, font, color: ink });
    if (l2 != null) {
      page.drawText(pdfSafe(l2), { x: M + 268, y, size: 8, font, color: muted });
      page.drawText(pdfSafe(v2 || '-'), { x: M + 350, y, size: 10, font, color: ink });
    }
    y -= 7;
  };
  const kvWide = (label, value) => {
    need(16); y -= 11;
    page.drawText(pdfSafe(label), { x: M, y, size: 8, font, color: muted });
    const lines = wrap(value || '-', 10, font, CW - 84);
    page.drawText(pdfSafe(lines[0]), { x: M + 84, y, size: 10, font, color: ink });
    y -= 7;
    for (let i = 1; i < lines.length; i++) { need(15); y -= 11; page.drawText(pdfSafe(lines[i]), { x: M + 84, y, size: 10, font, color: ink }); y -= 4; }
  };
  // Simple bordered table. cols: [{title,w,align}]. rows: array of cell arrays
  // where a cell is a string or {text,color,bold}. footer optional (same shape).
  const table = (cols, rows, footer) => {
    const hh = 19, lineH = 11;
    need(hh + lineH + 6);
    y -= hh;
    page.drawRectangle({ x: M, y, width: CW, height: hh, color: rgb(0.96, 0.96, 0.94) });
    let x = M;
    cols.forEach(c => { page.drawText(pdfSafe(c.title), { x: x + 5, y: y + 6, size: 7.5, font: bold, color: muted }); x += c.w; });
    const drawRow = (cells, bg) => {
      // Lay out each cell, wrapping its text to the column width so long expense
      // types / descriptions stack onto extra lines instead of being truncated.
      // A cell may set `span` to merge that many columns (used by total rows).
      const laid = [];
      for (let i = 0; i < cols.length;) {
        const cell = cells[i] == null ? '' : cells[i];
        const span = (typeof cell === 'object' && cell.span) ? cell.span : 1;
        let w = 0; for (let k = 0; k < span && cols[i + k]; k++) w += cols[i + k].w;
        const f = (typeof cell === 'object' && cell.bold) ? bold : font;
        const color = (typeof cell === 'object' && cell.color) || ink;
        const raw = typeof cell === 'object' ? (cell.text != null ? cell.text : '') : cell;
        laid.push({ w, align: cols[i].align, f, color, lines: wrap(String(raw), 9, f, w - 10) });
        i += span;
      }
      const nLines = laid.reduce((m, c) => Math.max(m, c.lines.length), 1);
      const rh = nLines * lineH + 6;
      need(rh); y -= rh;
      if (bg) page.drawRectangle({ x: M, y, width: CW, height: rh, color: bg });
      let cx = M;
      laid.forEach(({ w, align, f, color, lines }) => {
        lines.forEach((ln, li) => {
          const tx = align === 'right' ? cx + w - 5 - f.widthOfTextAtSize(ln, 9) : cx + 5;
          page.drawText(ln, { x: tx, y: y + rh - 11 - li * lineH, size: 9, font: f, color });
        });
        cx += w;
      });
      page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rule });
    };
    rows.forEach(r => drawRow(r));
    if (footer) drawRow(footer, rgb(0.98, 0.965, 0.945));
  };

  const claimHeader = (c) => {
    newPage();
    const title = c.type === 'meal' ? (c.scheme === 'gps' ? 'Meal Allowance Claim (GPS)' : 'Meal Allowance Claim') : c.type === 'advance' ? 'Cash Advance' : 'Reimbursement Claim';
    if (logo) { const lw = 104, lh = lw * 213 / 631; page.drawImage(logo, { x: M, y: H - M - lh, width: lw, height: lh }); }
    else page.drawText('Cibes', { x: M, y: H - M - 20, size: 22, font: bold, color: orange });
    const rx = M + 128;
    page.drawText(title, { x: rx, y: H - M - 8, size: 16, font: bold, color: ink });
    const stText = owesRefund(c) ? 'Awaiting refund' : (c.type === 'advance' && ADV_STATUS_LABEL[c.status]) || STATUS_LABEL[c.status] || c.status;
    const stKey = pillClass(c);
    page.drawText(`${pdfSafe(c.claim_no)}   ${String(stText).toUpperCase()}`,
      { x: rx, y: H - M - 26, size: 9.5, font: bold, color: stColor[stKey] || muted });
    page.drawText(`Submitted ${fmtDateTime(c.created_at)}`, { x: rx, y: H - M - 40, size: 8.5, font, color: muted });
    y = H - M - 58;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.5, color: orange });
    y -= 6;
  };

  // A rejected line still prints (it's part of the record) but bracketed, with
  // its reason ahead of the description, and the total becomes the payable one.
  const pdfAmt = (l, c) => lineRejected(l) ? `(${money(l.amount, c.currency)})` : money(l.amount, c.currency);
  const pdfDesc = (l) => lineRejected(l)
    ? [`REJECTED by ${l.rejected.by || 'approver'}: ${l.rejected.reason}`,
       l.resubmitted_doc_no ? `re-claimed on ${l.resubmitted_doc_no}` : '', l.description || ''].filter(Boolean).join(' | ')
    : (l.description || '');
  const pdfTotal = (c, label) => (c.lines || []).some(lineRejected) ? (c.type === 'advance' ? 'COUNTED' : 'PAYABLE') : label;
  const drawDetails = (c) => {
    if (c.type === 'advance') {
      kvRow('Claimant', c.claimant_name, 'Department', c.department);
      kvRow('Recipient', c.recipient_name, 'Bank', c.bank_name);
      kvRow('Account no.', c.bank_account_no);
      kvWide('Purpose', c.purpose);
      kvRow('Advance requested', money(c.amount, c.currency));
      section('Realization - actual transactions');
      const cols = [
        { title: 'Date', w: 66 }, { title: 'DB No.', w: 74 }, { title: 'Type of expense', w: 130 },
        { title: 'Amount', w: 80, align: 'right' }, { title: 'Description', w: CW - 350 }
      ];
      const lines = c.lines || [];
      const rows = lines.map(l => [l.line_date, dbFmt(l.db_no), l.expense_type, pdfAmt(l, c), pdfDesc(l)]);
      table(cols, rows.length ? rows : [['', '', 'No realization yet', '', '']],
        [{ text: pdfTotal(c, 'TOTAL SPENT'), bold: true, span: 3 }, '', '', { text: money(c.realized_total, c.currency), bold: true }, '']);
      // Settlement summary: advance vs actual spend, and which way the balance goes.
      if (lines.length) {
        const diff = (c.realized_total || 0) - (c.amount || 0);
        const dir = c.status === 'settled' ? c.settlement_direction : (diff > 0 ? 'topup' : diff < 0 ? 'return' : 'even');
        const amt = c.status === 'settled' ? c.settlement : Math.abs(diff);
        const msg = dir === 'topup' ? 'Top-up owed to employee: ' + money(amt, c.currency)
          : dir === 'return' ? (c.status === 'settled' ? 'Refund received from employee: ' : 'Balance to be returned by employee: ') + money(amt, c.currency)
          : 'Advance and actual spend match exactly.';
        section(c.status === 'settled' ? 'Settlement' : 'Settlement (pending)');
        line(msg, { size: 10 });
        if (c.status === 'settled' && c.settlement_note) line(c.settlement_note, { size: 9, color: muted });
      }
    } else if (c.type === 'meal' && c.scheme === 'gps') {
      // GPS meal allowance: each day's trip, distance from base and what it pays.
      kvRow('Claimant', c.claimant_name, 'Department', c.department);
      kvRow('Recipient', c.recipient_name, 'Bank', c.bank_name);
      kvRow('Account no.', c.bank_account_no);
      section('Meal allowance (GPS) - days');
      const cols = [
        { title: 'Date', w: 66 }, { title: 'Trip', w: 84 }, { title: 'Radius from base', w: 130 },
        { title: 'Amount', w: 80, align: 'right' }, { title: 'Details', w: CW - 360 }
      ];
      const trip = (l) => l.trip_type === 'out_of_town' ? `Out of town (${l.meals.length} meal${l.meals.length === 1 ? '' : 's'})` : 'In town';
      const where = (l) => l.distance_km == null ? '' : `${(Math.round(l.distance_km * 10) / 10).toFixed(1)} km RADIUS from ${pdfSafe((l.base && l.base.name) || 'base')}`
        + (l.gps ? ` (${l.gps.lat.toFixed(5)}, ${l.gps.lng.toFixed(5)})` : '');
      const amt = (l) => l.approved_amount != null
        ? `${money(l.payable_amount, c.currency)} (claimed ${money(l.amount, c.currency)})` : pdfAmt(l, c);
      const details = (l) => [l.approved_amount != null && l.approved_note ? `Approved by ${l.approved_by}: ${l.approved_note}` : '',
        dbFmt(l.site), l.job_category, pdfDesc(l)].filter(Boolean).join(' | ');
      const rows = (c.lines || []).map(l => [l.line_date, trip(l), where(l), amt(l), details(l)]);
      table(cols, rows.length ? rows : [['', '', 'No lines', '', '']],
        [{ text: pdfTotal(c, 'TOTAL'), bold: true, span: 3 }, '', '', { text: money(c.total_amount, c.currency), bold: true }, '']);
    } else if (c.type === 'meal') {
      kvRow('Claimant', c.claimant_name, 'Department', c.department);
      kvRow('Recipient', c.recipient_name, 'Bank', c.bank_name);
      kvRow('Account no.', c.bank_account_no);
      section('Meal allowance lines');
      const cols = [
        { title: 'Date', w: 66 }, { title: 'DB Number Site', w: 124 }, { title: 'Job Category', w: 90 },
        { title: 'Amount', w: 80, align: 'right' }, { title: 'Description', w: CW - 360 }
      ];
      const rows = (c.lines || []).map(l => [l.line_date, dbFmt(l.site), l.job_category, pdfAmt(l, c), pdfDesc(l)]);
      table(cols, rows.length ? rows : [['', '', 'No lines', '', '']],
        [{ text: pdfTotal(c, 'TOTAL'), bold: true, span: 3 }, '', '', { text: money(c.total_amount, c.currency), bold: true }, '']);
    } else {
      kvRow('Claimant', c.claimant_name, 'Department', c.department);
      kvRow('Recipient', c.recipient_name, 'Bank', c.bank_name);
      kvRow('Account no.', c.bank_account_no);
      section('Expense lines');
      const cols = [
        { title: 'Date', w: 66 }, { title: 'DB No.', w: 74 }, { title: 'Type of expense', w: 130 },
        { title: 'Amount', w: 80, align: 'right' }, { title: 'Description', w: CW - 350 }
      ];
      // Fall back to a single synthetic line for any legacy claim without lines.
      const lines = (c.lines && c.lines.length) ? c.lines : [{
        line_date: c.expense_date, db_no: c.db_no, expense_type: c.expense_type,
        amount: c.amount, description: c.description
      }];
      const rows = lines.map(l => [l.line_date, dbFmt(l.db_no), l.expense_type, pdfAmt(l, c), pdfDesc(l)]);
      table(cols, rows.length ? rows : [['', '', 'No lines', '', '']],
        [{ text: pdfTotal(c, 'TOTAL'), bold: true, span: 3 }, '', '', { text: money(c.amount, c.currency), bold: true }, '']);
    }
  };

  const drawApprovals = (c) => {
    section('Approvals');
    if (!c.approvers || !c.approvers.length) { line('No approval chain - processed by a Super Admin.', { size: 9.5, color: muted }); return; }
    const cols = [{ title: 'Step', w: 42 }, { title: 'Approver', w: CW - 42 - 96 - 120 }, { title: 'Decision', w: 96 }, { title: 'Date', w: 120 }];
    const rows = c.approvers.map((a, i) => {
      const st = stepStateFor(c, i + 1);
      const date = st === 'done' ? approvalActionDate(c, a.name, 'approved')
        : st === 'rejected' ? approvalActionDate(c, a.name, 'rejected') : '';
      return [String(i + 1), a.name, { text: STEP_STATE_LABEL[st], color: stColor[st] || muted, bold: true }, date || '-'];
    });
    table(cols, rows);
  };

  const drawHistory = (c) => {
    if (!c.history || !c.history.length) return;
    section('History');
    c.history.forEach(h => {
      const head = `${h.action.charAt(0).toUpperCase() + h.action.slice(1)}  -  ${h.actor_name} · ${fmtDateTime(h.created_at)}`;
      line(head.replace(/·/g, '·'), { size: 9.5, f: bold });
      if (h.comment) wrap('"' + h.comment + '"', 9, font, CW - 14).forEach(ln => line(ln, { x: M + 14, size: 9, color: muted, gap: 3 }));
      y -= 3;
    });
  };

  // Pack up to 4 image attachments onto a single full page. Two share it side
  // by side; three or four fall into a 2x2 grid; a lone image gets the same
  // half-width cell as a pair, centred, rather than filling the page. Each
  // image is scaled to fit ("contain") inside its cell under a filename caption.
  const drawImageGrid = (c, items) => {
    const p = pdf.addPage([W, H]);
    p.drawText(pdfSafe(`Attachments · ${c.claim_no}`), { x: M, y: H - M - 6, size: 8, font, color: muted });
    const top = H - M - 22, availH = top - M;
    const n = items.length, gap = 14;
    const cols = 2, rows = Math.ceil(n / cols);
    const cellW = (CW - gap * (cols - 1)) / cols;
    const cellH = (availH - gap * (rows - 1)) / rows;
    const capH = 13;
    items.forEach(({ att, img }, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const cx = n === 1 ? M + (CW - cellW) / 2 : M + col * (cellW + gap);
      const cellTop = top - row * (cellH + gap);
      let name = pdfSafe(att.original_name);
      while (name.length > 4 && font.widthOfTextAtSize(name, 8) > cellW) name = name.slice(0, -2);
      p.drawText(name, { x: cx, y: cellTop - 9, size: 8, font: bold, color: ink });
      const areaH = cellH - capH;
      const s = Math.min(cellW / img.width, areaH / img.height);
      const iw = img.width * s, ih = img.height * s;
      p.drawImage(img, {
        x: cx + (cellW - iw) / 2,
        y: cellTop - capH - (areaH - ih) / 2 - ih,
        width: iw, height: ih
      });
    });
  };
  const drawNotePage = (c, att, msg) => {
    const p = pdf.addPage([W, H]);
    p.drawText(pdfSafe(`Attachment · ${c.claim_no}`), { x: M, y: H - M - 6, size: 8, font, color: muted });
    p.drawText(pdfSafe(att.original_name), { x: M, y: H - M - 20, size: 11, font: bold, color: ink });
    p.drawText(pdfSafe(msg), { x: M, y: H - M - 44, size: 10, font, color: ink });
    p.drawText(pdfSafe(`${att.mime_type || 'unknown type'} · ${fmtBytes(att.size_bytes)}`), { x: M, y: H - M - 60, size: 9, font, color: muted });
  };
  // Render a claim's attachments: images are collected into `batch` and flushed
  // 4-to-a-page as grids; PDFs and load failures break the batch and take their
  // own full page(s), preserving the original attachment order.
  // Fetch every receipt's bytes up front, a few at a time, so they can be
  // embedded below in the original order — the requests overlap, the layout
  // doesn't change. A failed fetch stays null and still gets its note page.
  const fetchAttachments = (c, atts) => {
    const base = c.type === 'meal' ? '/meal-claims/' : c.type === 'advance' ? '/cash-advances/' : '/claims/';
    return mapLimit(atts, 4, async (att) => {
      try {
        const res = await fetch(`/api${base}${c.id}/attachments/${att.id}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('http');
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { bytes, mime: att.mime_type || res.headers.get('Content-Type') || '' };
      } catch { return null; }
    });
  };
  const isPdfAtt = (att, mime) => /pdf/i.test(mime) || /\.pdf$/i.test(att.original_name);
  const appendAttachments = async (c, atts, fetched) => {
    let batch = [];
    const flush = () => { for (let i = 0; i < batch.length; i += 4) drawImageGrid(c, batch.slice(i, i + 4)); batch = []; };
    for (let i = 0; i < atts.length; i++) {
      const att = atts[i];
      const got = fetched[i];
      if (!got) { flush(); drawNotePage(c, att, 'Could not load this attachment from storage.'); continue; }
      const { bytes, mime } = got;
      if (isPdfAtt(att, mime)) {
        flush();
        try {
          const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
          const copied = await pdf.copyPages(src, src.getPageIndices());
          copied.forEach(p => pdf.addPage(p));
        } catch { drawNotePage(c, att, 'This PDF could not be embedded.'); }
        continue;
      }
      try {
        const png = await rasterToPng(bytes, mime);
        batch.push({ att, img: await pdf.embedPng(png.bytes) });
      } catch { flush(); drawNotePage(c, att, "This file type can't be shown inline - download it from the portal."); }
    }
    flush();
  };

  for (const c of claims) {
    claimHeader(c);
    drawDetails(c);
    drawApprovals(c);
    drawHistory(c);
    // Claims expose a flat top-level list; cash advances can carry both — the
    // request's supporting documents at the top level and the realization's
    // receipts per line — so those are concatenated rather than preferred.
    const lineAtts = (c.lines || []).flatMap(l => l.attachments || []);
    const atts = c.type === 'advance'
      ? (c.attachments || []).concat(lineAtts)
      : ((c.attachments && c.attachments.length) ? c.attachments : lineAtts);
    if (atts.length) {
      section(`Attachments (${atts.length})`);
      atts.forEach(a => line(`- ${a.original_name}  (${fmtBytes(a.size_bytes)})`, { size: 9, gap: 3 }));
    }
    need(26); y -= 14;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rule });
    y -= 11;
    page.drawText(pdfSafe(`Generated ${fmtDateTime(new Date().toISOString())}  ·  Cibes Reimbursement Portal`), { x: M, y, size: 7.5, font, color: muted });
    await appendAttachments(c, atts, await fetchAttachments(c, atts));
  }
  return pdf.save();
}

// Date shown on an approver step, pulled from the matching history entry.
function approvalActionDate(c, name, action) {
  const h = (c.history || []).find(x => x.actor_name === name && x.action === action);
  return h ? fmtDateTime(h.created_at) : '';
}
