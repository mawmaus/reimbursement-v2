'use strict';

// Receipts: the photo editor, document scanning, receipt chips and uploads.
// A plain <script> sharing globals with app.js (loaded after it; see
// index.html). Nothing here runs app code at load beyond wiring listeners —
// js/start.js boots the app once every script is in.

// ---------------------------------------------------------------------------
// Receipt photo editor — crop, rotate, and (optionally) burn in a date + GPS
// location stamp. Opens for every picked image so a receipt photographed on a
// phone can be straightened/tightened and carries a tamper-evident capture
// stamp, the way dedicated "GPS camera" apps produce. PDFs and animated GIFs
// skip it (nothing to crop/rotate). Returns a new JPEG File, the untouched
// original (if the browser can't decode it), or null when the user cancels.
// ---------------------------------------------------------------------------
const STAMP_FONT = '-apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// Draw `img` rotated by `deg` degrees into a new canvas sized to the rotated
// image's bounding box. Shared by the on-screen preview and the full-res export
// so the two always agree on geometry.
function rotatedImageCanvas(img, deg) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const rad = deg * Math.PI / 180;
  const s = Math.abs(Math.sin(rad)), c = Math.abs(Math.cos(rad));
  const bw = Math.max(1, Math.round(w * c + h * s));
  const bh = Math.max(1, Math.round(w * s + h * c));
  const cnv = document.createElement('canvas');
  cnv.width = bw; cnv.height = bh;
  const ctx = cnv.getContext('2d');
  ctx.translate(bw / 2, bh / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return cnv;
}

// One-shot geolocation as a promise.
function getPositionOnce(opts) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no geolocation'));
    navigator.geolocation.getCurrentPosition(resolve, reject, opts);
  });
}

// Turn a coordinate into a street address via our same-origin proxy (which
// forwards to a public geocoder). Best-effort — null on any failure.
async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch(`/api/geocode?lat=${lat}&lon=${lon}&lang=${encodeURIComponent(I18N.getLang())}`);
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.address) || null;
  } catch { return null; }
}

// Format the capture time as "16 Aug 2026 · 14:32:07 GMT+7".
function fmtStampTime(d) {
  const M = I18N.months();
  const p2 = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = off >= 0 ? '+' : '-';
  const oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
  const gmt = `GMT${sign}${oh}${om ? ':' + p2(om) : ''}`;
  return `${d.getDate()} ${M[d.getMonth()]} ${d.getFullYear()} · `
    + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${gmt}`;
}
// Signed decimal coordinate → "3.589200°N" style.
function fmtLat(v) { return `${Math.abs(v).toFixed(6)}°${v >= 0 ? 'N' : 'S'}`; }
function fmtLon(v) { return `${Math.abs(v).toFixed(6)}°${v >= 0 ? 'E' : 'W'}`; }

// Wrap `text` to physical lines no wider than maxWidth (ctx.font already set).
function wrapTextLines(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = []; let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (!cur || ctx.measureText(test).width <= maxWidth) cur = test;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

// Lay out the capture stamp for a band `w` px wide. `lines` is [{ text, bold }].
// Font sizes scale with `w`, so the preview strip and the full-res export are
// proportionally identical. Address lines are clamped to two rows so the band
// stays a caption, not a paragraph. Returns null when there is nothing to draw.
function measureCaptureStamp(ctx, w, lines) {
  if (!lines || !lines.length) return null;
  const fs = Math.min(Math.max(w * 0.026, 12), 44);
  const headFs = fs * 1.14;
  const padX = fs * 0.85, padY = fs * 0.62, accent = Math.max(3, fs * 0.24);
  const textLeft = padX + accent + fs * 0.5;
  const maxTextW = w - textLeft - padX;
  // Expand logical lines into physical (wrapped) rows carrying their own font.
  const rows = [];
  lines.forEach(ln => {
    const size = ln.bold ? headFs : fs;
    ctx.font = `${ln.bold ? 700 : 500} ${size}px ${STAMP_FONT}`;
    let wrapped = wrapTextLines(ctx, ln.text, maxTextW);
    if (wrapped.length > 2) { // clamp long addresses to two rows + ellipsis
      wrapped = wrapped.slice(0, 2);
      while (wrapped[1] && ctx.measureText(wrapped[1] + '…').width > maxTextW && wrapped[1].length > 1) {
        wrapped[1] = wrapped[1].slice(0, -1);
      }
      wrapped[1] = (wrapped[1] || '').replace(/\s+$/, '') + '…';
    }
    wrapped.forEach(txt => rows.push({ txt, size, bold: ln.bold }));
  });
  const rowH = fs * 1.32;
  return { fs, padX, padY, accent, textLeft, rows, rowH, height: padY * 2 + rows.length * rowH };
}

// Height of the stamp band under a `w`-wide photo (0 when the stamp is off).
function captureStampHeight(ctx, w, lines) {
  const m = measureCaptureStamp(ctx, w, lines);
  return m ? Math.ceil(m.height) : 0;
}

// Draw the capture stamp as a band of its own. It sits *below* the photo rather
// than on top of it, so nothing in the picture is covered. (x, y) is the band's
// top-left corner and `w` its width; returns the height it consumed.
function drawCaptureStamp(ctx, x, y, w, lines) {
  const m = measureCaptureStamp(ctx, w, lines);
  if (!m) return 0;
  const bandH = Math.ceil(m.height);
  ctx.save();
  // Solid dark caption band under the photo.
  ctx.fillStyle = '#121214';
  ctx.fillRect(x, y, w, bandH);
  // Brand accent bar on the left.
  ctx.fillStyle = '#f7982a';
  ctx.fillRect(x + m.padX, y + m.padY, m.accent, bandH - m.padY * 2);
  // Text.
  ctx.textBaseline = 'top';
  let ty = y + m.padY;
  m.rows.forEach(r => {
    ctx.font = `${r.bold ? 700 : 500} ${r.size}px ${STAMP_FONT}`;
    ctx.fillStyle = r.bold ? '#ffffff' : 'rgba(255,255,255,0.92)';
    ctx.fillText(r.txt, x + m.textLeft, ty + (m.rowH - r.size) / 2);
    ty += m.rowH;
  });
  ctx.restore();
  return bandH;
}

// ---------------------------------------------------------------------------
// Document detection, perspective correction and scan cleanup.
//
// The three pieces a dedicated scanner app does for you: find the sheet of
// paper in the photo, flatten the angle it was shot at, and even out the
// lighting so it reads like something that came off a flatbed. All of it runs
// on canvas in the browser — no wasm build, nothing uploaded to find the edges.
//
// Detection is deliberately best-effort: it proposes a quad and the user drags
// the corners if it got it wrong. A receipt on a patterned desk or a white
// table defeats it, and a confidently wrong silent crop is worse than none.
// ---------------------------------------------------------------------------

// Downscale `src` into a small grayscale buffer. Detection never needs full
// resolution — ~320px keeps every pass below a frame's worth of work.
function grayscaleCopy(src, maxSide) {
  const s = Math.min(1, maxSide / Math.max(src.width, src.height));
  const w = Math.max(8, Math.round(src.width * s));
  const h = Math.max(8, Math.round(src.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(src, 0, 0, w, h);
  const d = cx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  return { g, w, h };
}

// Separable box blur via a running sum — O(pixels), independent of radius.
function boxBlur(src, w, h, r) {
  const clampX = x => x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  const clampY = y => y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const win = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + clampX(x)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      sum += src[row + clampX(x + r + 1)] - src[row + clampX(x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[clampY(y) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      sum += tmp[clampY(y + r + 1) * w + x] - tmp[clampY(y - r) * w + x];
    }
  }
  return out;
}

// Separable local maximum ("dilate"). Used to estimate paper white: the
// brightest value nearby is the page, whatever the print on it is doing.
function boxDilate(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, src[y * w + k]);
      tmp[y * w + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = -Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

// Otsu's method: the grey level that best splits the histogram into two classes.
function otsuThreshold(g) {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i] < 0 ? 0 : g[i] > 255 ? 255 : g[i] | 0]++;
  const total = g.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = i; }
  }
  return thr;
}

const polyArea = p => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return Math.abs(a) / 2;
};

// Andrew's monotone chain.
function convexHull(pts) {
  if (pts.length < 4) return pts.slice();
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// Drop the vertex that costs the least area until the ring is short enough, so
// the survivors are the ones that actually define the shape's corners.
function simplifyRing(ring, limit) {
  const r = ring.slice();
  while (r.length > limit) {
    let worst = 0, loss = Infinity;
    for (let i = 0; i < r.length; i++) {
      const a = r[(i - 1 + r.length) % r.length], b = r[i], c = r[(i + 1) % r.length];
      const cost = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
      if (cost < loss) { loss = cost; worst = i; }
    }
    r.splice(worst, 1);
  }
  return r;
}

// The four hull points that enclose the most area — the ring is already convex
// and short, so the brute force is a few thousand iterations at most.
function maxAreaQuad(ring) {
  const n = ring.length;
  if (n < 4) return null;
  if (n === 4) return ring.slice();
  let best = null, bestArea = 0;
  for (let i = 0; i < n - 3; i++)
    for (let j = i + 1; j < n - 2; j++)
      for (let k = j + 1; k < n - 1; k++)
        for (let l = k + 1; l < n; l++) {
          const q = [ring[i], ring[j], ring[k], ring[l]];
          const a = polyArea(q);
          if (a > bestArea) { bestArea = a; best = q; }
        }
  return best;
}

// Put the corners in a predictable order: top-left, top-right, bottom-right,
// bottom-left, so index 0..3 means the same thing everywhere downstream.
function orderQuad(q) {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  // Sorting by bearing gives a ring; y grows downward, so that ring is clockwise.
  const ring = q.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0, bestSum = Infinity;
  ring.forEach((p, i) => { const s = (p.x - cx) + (p.y - cy); if (s < bestSum) { bestSum = s; start = i; } });
  return [0, 1, 2, 3].map(i => ring[(start + i) % 4]);
}

// How much this quad looks like a document in frame: 0 rejects it outright.
function quadScore(q, w, h) {
  const area = polyArea(q);
  if (area < w * h * 0.10) return 0;                       // too small to be the subject
  const side = i => Math.hypot(q[(i + 1) % 4].x - q[i].x, q[(i + 1) % 4].y - q[i].y);
  if (Math.min(side(0), side(1), side(2), side(3)) < Math.min(w, h) * 0.10) return 0; // a sliver
  for (let i = 0; i < 4; i++) {                            // corners must stay roughly square
    const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
    const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
    const denom = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (!denom) return 0;
    const deg = Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / denom))) * 180 / Math.PI;
    if (deg < 45 || deg > 135) return 0;
  }
  return area / (w * h);
}

// Largest blob in `mask` → convex hull → the quad that best covers it.
// Returns null when the blob isn't quadrilateral enough to trust.
function quadFromMask(mask, w, h) {
  const n = w * h;
  const seen = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let id = 0, bestId = -1, bestSize = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i] || seen[i]) continue;
    let sp = 0, size = 0;
    stack[sp++] = i; seen[i] = 1;
    while (sp) {
      const p = stack[--sp];
      comp[p] = id; size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    if (size > bestSize) { bestSize = size; bestId = id; }
    id++;
  }
  if (bestId < 0 || bestSize < n * 0.08) return null;
  // Only the first and last pixel of each row can sit on the hull, so the hull
  // input stays a few hundred points instead of the whole blob.
  const pts = [];
  for (let y = 0; y < h; y++) {
    let lo = -1, hi = -1;
    for (let x = 0; x < w; x++) if (comp[y * w + x] === bestId) { if (lo < 0) lo = x; hi = x; }
    if (lo >= 0) { pts.push({ x: lo, y }); if (hi !== lo) pts.push({ x: hi, y }); }
  }
  const hull = convexHull(pts);
  if (hull.length < 4) return null;
  const quad = maxAreaQuad(simplifyRing(hull, 12));
  if (!quad) return null;
  const ordered = orderQuad(quad);
  const area = polyArea(ordered);
  // A quad that leaves a lot of its own hull outside isn't a quad — it's a blob.
  if (area < polyArea(hull) * 0.72) return null;
  // And the blob has to actually fill the quad. The background *around* a
  // document is a single huge ring whose hull is the whole frame, so without
  // this it would outscore the document every time; a ring fills only the part
  // of the frame the page doesn't, and fails here.
  if (bestSize < area * 0.70) return null;
  const score = quadScore(ordered, w, h);
  return score ? { quad: ordered, score } : null;
}

// Find the document in `src` (a canvas). Returns four corners in `src`
// coordinates ordered TL, TR, BR, BL, or null when nothing convincing is there.
function detectDocumentQuad(src) {
  try {
    const { g, w, h } = grayscaleCopy(src, 320);
    const smooth = boxBlur(g, w, h, 1);                    // kill JPEG speckle
    const thr = otsuThreshold(smooth);
    const n = w * h;
    // Paper is normally the brighter class, but a receipt can be photographed
    // on a light table with a dark backing — try both ways and keep the winner.
    const light = new Uint8Array(n), dark = new Uint8Array(n);
    for (let i = 0; i < n; i++) { if (smooth[i] > thr) light[i] = 1; else dark[i] = 1; }
    const a = quadFromMask(light, w, h);
    const b = quadFromMask(dark, w, h);
    const win = !a ? b : !b ? a : (a.score >= b.score ? a : b);
    if (!win) return null;
    const sx = src.width / w, sy = src.height / h;
    return win.quad.map(p => ({
      x: Math.max(0, Math.min(src.width, p.x * sx)),
      y: Math.max(0, Math.min(src.height, p.y * sy))
    }));
  } catch {
    return null; // a tainted or oversized canvas just means "no suggestion"
  }
}

// Solve for the projective transform taking the four `from` points to the four
// `to` points. Returns [a,b,c,d,e,f,g,h] where
//   x' = (a·x + b·y + c) / (g·x + h·y + 1),  y' = (d·x + e·y + f) / (g·x + h·y + 1)
function solveHomography(from, to) {
  const A = [], B = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i], u = to[i].x, v = to[i].y;
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); B.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); B.push(v);
  }
  for (let c = 0; c < 8; c++) {                            // Gauss-Jordan, partial pivoting
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-9) return null;           // degenerate quad
    [A[c], A[piv]] = [A[piv], A[c]];
    [B[c], B[piv]] = [B[piv], B[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      B[r] -= f * B[c];
    }
  }
  return B.map((b, i) => b / A[i][i]);
}

// Draw one mesh cell. Each point carries where it is in the source (x, y) and
// where it lands in the output (u, v); over a cell that small the projective
// map is affine to within a fraction of a pixel, so the browser's own sampler
// does the work — no per-pixel JS, and full-quality filtering for free.
function drawWarpedTriangle(ctx, src, p0, p1, p2) {
  const sx1 = p1.x - p0.x, sy1 = p1.y - p0.y, sx2 = p2.x - p0.x, sy2 = p2.y - p0.y;
  const det = sx1 * sy2 - sx2 * sy1;
  if (!det) return;
  const dx1 = p1.u - p0.u, dy1 = p1.v - p0.v, dx2 = p2.u - p0.u, dy2 = p2.v - p0.v;
  const a = (dx1 * sy2 - dx2 * sy1) / det;
  const b = (dy1 * sy2 - dy2 * sy1) / det;
  const c = (dx2 * sx1 - dx1 * sx2) / det;
  const d = (dy2 * sx1 - dy1 * sx2) / det;
  const e = p0.u - a * p0.x - c * p0.y;
  const f = p0.v - b * p0.x - d * p0.y;
  // Push every edge of the clip a pixel outward so neighbouring cells overlap.
  // Left flush against each other they meet at an antialiased boundary, and two
  // half-covered edges composite to a visible hairline grid over the whole
  // page. Scaling about the incenter moves all three edges out equally.
  const ax = p1.u - p0.u, ay = p1.v - p0.v;
  const la = Math.hypot(p2.u - p1.u, p2.v - p1.v);   // side opposite p0
  const lb = Math.hypot(p0.u - p2.u, p0.v - p2.v);   // opposite p1
  const lc = Math.hypot(ax, ay);                      // opposite p2
  const per = la + lb + lc;
  if (!per) return;
  const ix = (la * p0.u + lb * p1.u + lc * p2.u) / per;
  const iy = (la * p0.v + lb * p1.v + lc * p2.v) / per;
  const inradius = Math.abs(ax * (p2.v - p0.v) - (p2.u - p0.u) * ay) / per; // 2·area / perimeter
  const k = inradius > 0.01 ? (inradius + 1) / inradius : 1;
  const out = q => ({ u: ix + (q.u - ix) * k, v: iy + (q.v - iy) * k });
  const g0 = out(p0), g1 = out(p1), g2 = out(p2);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(g0.u, g0.v); ctx.lineTo(g1.u, g1.v); ctx.lineTo(g2.u, g2.v);
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(a, b, c, d, e, f);
  // Only this cell's slice of the source needs drawing; the transform puts it
  // in the right place because it is drawn at its own source coordinates.
  const bx = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)) - 1);
  const by = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)) - 1);
  const bw = Math.min(src.width - bx, Math.ceil(Math.max(p0.x, p1.x, p2.x)) - bx + 2);
  const bh = Math.min(src.height - by, Math.ceil(Math.max(p0.y, p1.y, p2.y)) - by + 2);
  if (bw > 0 && bh > 0) ctx.drawImage(src, bx, by, bw, bh, bx, by, bw, bh);
  ctx.restore();
}

// The output size that keeps the document's own proportions: each side as long
// as its longer version in the photo, capped so huge phone shots stay sane.
function quadOutputSize(quad, cap) {
  const len = (a, b) => Math.hypot(quad[b].x - quad[a].x, quad[b].y - quad[a].y);
  const w = Math.max(len(0, 1), len(3, 2));
  const h = Math.max(len(0, 3), len(1, 2));
  const s = Math.min(1, cap / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// Flatten `quad` (in `src` coordinates) into a straight-on outW × outH image.
function warpQuad(src, quad, outW, outH) {
  // Each cell is drawn with one drawImage, which has no mip-maps behind it, so
  // asking it for a big reduction in a single step aliases badly. Halve the
  // source down first — repeated halving keeps the detail that survives.
  let src2 = src, q = quad;
  const spanOf = p => Math.max(
    Math.max(...p.map(v => v.x)) - Math.min(...p.map(v => v.x)),
    Math.max(...p.map(v => v.y)) - Math.min(...p.map(v => v.y)));
  while (spanOf(q) >= Math.max(outW, outH) * 2 && src2.width > 64 && src2.height > 64) {
    const half = document.createElement('canvas');
    half.width = Math.max(1, Math.round(src2.width / 2));
    half.height = Math.max(1, Math.round(src2.height / 2));
    const hx = half.getContext('2d');
    hx.imageSmoothingEnabled = true;
    hx.imageSmoothingQuality = 'high';
    hx.drawImage(src2, 0, 0, half.width, half.height);
    const fx = half.width / src2.width, fy = half.height / src2.height;
    q = q.map(p => ({ x: p.x * fx, y: p.y * fy }));
    src2 = half;
  }
  src = src2; quad = q;

  const rect = [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }];
  const H = solveHomography(rect, quad);   // output space → source space
  if (!H) return null;
  const cnv = document.createElement('canvas');
  cnv.width = outW; cnv.height = outH;
  const ctx = cnv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Anything the mesh doesn't reach — a corner dragged off the edge of the
  // photo, or the transparent wedge a rotation leaves behind — reads as page
  // rather than as the black that transparency turns into once it is a JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  const N = 16;
  const grid = [];
  for (let j = 0; j <= N; j++) {
    const row = [];
    for (let i = 0; i <= N; i++) {
      const u = outW * i / N, v = outH * j / N;
      const w = H[6] * u + H[7] * v + 1;
      row.push({ u, v, x: (H[0] * u + H[1] * v + H[2]) / w, y: (H[3] * u + H[4] * v + H[5]) / w });
    }
    grid.push(row);
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i + 1], d = grid[j + 1][i];
    drawWarpedTriangle(ctx, src, a, b, c);
    drawWarpedTriangle(ctx, src, a, c, d);
  }
  return cnv;
}

// Estimate the lighting across the page: the local maximum is the paper itself
// (print only ever makes a pixel darker), smoothed into a gradient. Computed on
// a downscaled copy — it is low-frequency by construction, so nothing is lost.
function estimateIllumination(lum, W, H) {
  const step = Math.max(1, Math.round(Math.max(W, H) / 200));
  const sw = Math.max(1, Math.ceil(W / step)), sh = Math.max(1, Math.ceil(H / step));
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let sum = 0, count = 0;
    for (let yy = y * step; yy < Math.min(H, (y + 1) * step); yy++)
      for (let xx = x * step; xx < Math.min(W, (x + 1) * step); xx++) { sum += lum[yy * W + xx]; count++; }
    small[y * sw + x] = count ? sum / count : 255;
  }
  const r = Math.max(2, Math.round(Math.max(sw, sh) / 16));
  const paper = boxDilate(small, sw, sh, r);
  const bg = boxBlur(boxBlur(paper, sw, sh, r), sw, sh, r);
  // Bilinear back up to full size.
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = Math.max(0, Math.min(sh - 1, (y + 0.5) / step - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.max(0, Math.min(sw - 1, (x + 0.5) / step - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = bg[y0 * sw + x0], b = bg[y0 * sw + x1], c = bg[y1 * sw + x0], d = bg[y1 * sw + x1];
      out[y * W + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  }
  return out;
}

// Even out the lighting so the page reads as a scan. 'scan' keeps the colour
// (stamps and ink stay legible) and just divides the shadow out, then stretches
// the levels; 'bw' thresholds each pixel against its own local paper white,
// which is what survives a creased receipt under a desk lamp.
function enhanceDocument(cnv, mode) {
  if (mode !== 'scan' && mode !== 'bw') return cnv;
  const W = cnv.width, H = cnv.height, n = W * H;
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const lum = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) lum[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  const bg = estimateIllumination(lum, W, H);
  if (mode === 'bw') {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const v = lum[i] < bg[i] * 0.82 ? 0 : 255;
      d[p] = d[p + 1] = d[p + 2] = v;
    }
  } else {
    const BLACK = 42, WHITE = 238, span = WHITE - BLACK;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const gain = 255 / Math.max(24, bg[i]);
      for (let k = 0; k < 3; k++) {
        const v = d[p + k] * gain;
        d[p + k] = v <= BLACK ? 0 : v >= WHITE ? 255 : (v - BLACK) * 255 / span;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return cnv;
}

// The editor itself. Resolves with a File (edited JPEG), the original file (on
// a decode error), or null (cancelled).
function editImage(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); }; // can't decode — attach as-is
    img.onload = () => setup();
    img.src = url;

    let settled = false;
    function settle(result) {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      document.removeEventListener('keydown', onKey, true);
      $('#modal2Scrim').removeEventListener('click', onScrim);
      $('#modal2').classList.remove('ph-modal');
      closeModal2();
      resolve(result);
    }
    const onScrim = () => settle(null);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settle(null); }
    };

    function setup() {
      const shotAt = new Date();
      let angle = 0;            // free rotation in degrees (dial + 90° buttons)
      let stampOn = true;
      let geo = null;           // { lat, lon, acc, address? }
      let geoStatus = 'idle';   // idle | locating | located | denied
      let crop = null;          // { x, y, w, h } in stage (display) pixels
      let stageW = 0, stageH = 0, rc = null;
      let mode = 'rect';        // rect = box crop | doc = four-corner deskew
      // The corners live in the original photo's own pixels, so rotating or
      // resizing the stage carries them along instead of losing them; `quad`
      // is the same four points projected into the current stage.
      let quadSrc = null;       // [TL, TR, BR, BL] in source-image pixels
      let quad = null;          // the same, in stage pixels
      let detected = null;      // null = not tried | true/false = what detection found
      let scanMode = 'off';     // off | scan | bw
      let view = 'edit';        // edit = photo + overlay | result = finished image
      let stageBase = null;     // stage-sized photo with the scan filter applied
      let resultPreview = null; // cached render of the finished image
      const totalDeg = () => ((angle % 360) + 360) % 360;
      // Angle wrapped into -180..180 for display and the dial knob position.
      const displayAngle = () => ((angle % 360) + 540) % 360 - 180;

      openModal2(`
        <div class="modal-head"><h2>${esc(t('Edit photo'))}</h2>
          <button class="x-btn" id="phCancelX" aria-label="${esc(t('Cancel'))}">×</button></div>
        <div class="modal-body ph-body">
          <div class="ph-stage" id="phStage">
            <div class="ph-frame" id="phFrame">
              <canvas class="ph-canvas" id="phCanvas"></canvas>
              <div class="ph-crop" id="phCrop">
                <span class="ph-handle ph-edge" data-h="n"></span><span class="ph-handle ph-edge" data-h="s"></span>
                <span class="ph-handle ph-edge" data-h="w"></span><span class="ph-handle ph-edge" data-h="e"></span>
                <span class="ph-handle ph-corner" data-h="nw"></span><span class="ph-handle ph-corner" data-h="ne"></span>
                <span class="ph-handle ph-corner" data-h="sw"></span><span class="ph-handle ph-corner" data-h="se"></span>
              </div>
              <div class="ph-quad" id="phQuad" hidden>
                <span class="ph-handle ph-corner ph-qh" data-q="0"></span><span class="ph-handle ph-corner ph-qh" data-q="1"></span>
                <span class="ph-handle ph-corner ph-qh" data-q="2"></span><span class="ph-handle ph-corner ph-qh" data-q="3"></span>
              </div>
              <canvas class="ph-loupe" id="phLoupe" width="132" height="132"></canvas>
              <canvas class="ph-stampbar" id="phStampBar"></canvas>
            </div>
          </div>
          <div class="ph-tools">
            <div class="ph-optgrid">
              <div class="ph-opt">
                <span class="ph-opt-label">${esc(t('Crop'))}</span>
                <div class="ph-seg" id="phModeSeg" role="group" aria-label="${esc(t('Crop'))}">
                  <button type="button" data-v="rect" class="on">${esc(t('Rectangle'))}</button>
                  <button type="button" data-v="doc">${esc(t('Document'))}</button>
                </div>
              </div>
              <div class="ph-opt">
                <span class="ph-opt-label">${esc(t('Scan filter'))}</span>
                <div class="ph-seg" id="phScanSeg" role="group" aria-label="${esc(t('Scan filter'))}">
                  <button type="button" data-v="off" class="on">${esc(t('Off'))}</button>
                  <button type="button" data-v="scan">${esc(t('Scan'))}</button>
                  <button type="button" data-v="bw">${esc(t('B&W'))}</button>
                </div>
              </div>
            </div>
            <div class="ph-docrow" id="phDocRow" hidden>
              <button type="button" class="btn btn-ghost btn-sm" id="phDetect">⌖ ${esc(t('Detect edges'))}</button>
              <button type="button" class="btn btn-ghost btn-sm" id="phPreview">${esc(t('Preview result'))}</button>
              <span class="ph-docnote" id="phDocNote"></span>
            </div>
            <div class="ph-rotrow">
              <button type="button" class="btn btn-ghost btn-sm" id="phRotL">↺ ${esc(t('Rotate left'))}</button>
              <button type="button" class="btn btn-ghost btn-sm" id="phRotR">↻ ${esc(t('Rotate right'))}</button>
              <button type="button" class="btn btn-ghost btn-sm" id="phReset">${esc(t('Reset'))}</button>
            </div>
            <div class="ph-dial-row">
              <div class="ph-dial" id="phDial" role="slider" tabindex="0"
                aria-label="${esc(t('Rotate'))}" aria-valuemin="-180" aria-valuemax="180" aria-valuenow="0">
                <div class="ph-dial-track"></div>
                <div class="ph-dial-knob" id="phDialKnob"></div>
                <div class="ph-dial-val" id="phDialVal">0°</div>
              </div>
              <div class="ph-dial-cap">
                <span class="ph-dial-title">${esc(t('Rotate'))}</span>
                <span class="ph-dial-hint">${esc(t('Drag the dial to straighten'))}</span>
              </div>
            </div>
            <label class="ph-stamp-toggle">
              <input type="checkbox" id="phStamp" checked />
              <span>${esc(t('Stamp date & location'))}</span>
            </label>
            <div class="ph-stamp-preview" id="phStampInfo"></div>
          </div>
        </div>
        <div class="ph-foot">
          <button type="button" class="btn btn-ghost" id="phCancel">${esc(t('Cancel'))}</button>
          <button type="button" class="btn btn-primary" id="phAttach">${esc(t('Attach photo'))}</button>
        </div>`);
      $('#modal2').classList.add('modal-wide', 'ph-modal');
      document.addEventListener('keydown', onKey, true);
      $('#modal2Scrim').addEventListener('click', onScrim);

      const stageEl = $('#phStage'), frameEl = $('#phFrame'), canvas = $('#phCanvas'), cropEl = $('#phCrop');
      const quadEl = $('#phQuad'), loupeEl = $('#phLoupe'), docRow = $('#phDocRow');
      const GUTTER = 22; // room around the image so edge/corner handles stay grabbable

      // Build the stage for the current rotation and (re)fit the crop box.
      function layout(resetCrop) {
        rc = rotatedImageCanvas(img, totalDeg());
        // Fit the rotated image into the available modal space (minus the gutter
        // that frames it, so handles at the image edge sit inside the stage).
        const maxW = Math.max(220, Math.min(stageEl.parentElement.clientWidth || 560, 620) - GUTTER * 2);
        const maxH = 420;
        // The stamp strip hangs below the photo, so the photo gets the stage
        // height minus the room the strip needs — reserved whatever the stamp
        // currently says, so nothing jumps when the location arrives.
        const fitScale = h => Math.min(maxW / rc.width, h / rc.height, 1);
        const probeW = Math.max(1, Math.round(rc.width * fitScale(maxH)));
        const scale = fitScale(Math.max(140, maxH - bandReserve(probeW)));
        stageW = Math.max(1, Math.round(rc.width * scale));
        stageH = Math.max(1, Math.round(rc.height * scale));
        canvas.width = stageW; canvas.height = stageH;
        frameEl.style.width = stageW + 'px';
        frameEl.style.height = stageH + 'px';
        if (resetCrop || !crop) crop = { x: 0, y: 0, w: stageW, h: stageH };
        else clampCrop();
        if (!quadSrc) runDetection();
        else { syncQuadFromSrc(); resultPreview = null; }
        buildStageBase();
        draw();
      }

      // -- Document mode ------------------------------------------------------

      // Source-image point ↔ rotated-canvas point, mirroring the transform
      // rotatedImageCanvas applies, so the two always agree.
      const srcSize = () => ({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
      function srcToRc(p) {
        const { w, h } = srcSize();
        const rad = totalDeg() * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
        const px = p.x - w / 2, py = p.y - h / 2;
        return { x: px * c - py * s + rc.width / 2, y: px * s + py * c + rc.height / 2 };
      }
      function rcToSrc(p) {
        const { w, h } = srcSize();
        const rad = totalDeg() * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
        const px = p.x - rc.width / 2, py = p.y - rc.height / 2;
        return { x: px * c + py * s + w / 2, y: -px * s + py * c + h / 2 };
      }
      // Project the stored corners into the stage for drawing and dragging.
      function syncQuadFromSrc() {
        if (!quadSrc) return;
        const k = stageW / rc.width;
        quad = quadSrc.map(p => { const r = srcToRc(p); return { x: r.x * k, y: r.y * k }; });
      }

      function runDetection() {
        const found = detectDocumentQuad(rc);
        detected = !!found;
        if (found) {
          quadSrc = found.map(rcToSrc);
        } else {
          // Nothing convincing — offer an inset rectangle so there is always
          // something sensible to drag rather than four corners in a heap.
          const { w, h } = srcSize();
          const ix = w * 0.08, iy = h * 0.08;
          quadSrc = [{ x: ix, y: iy }, { x: w - ix, y: iy }, { x: w - ix, y: h - iy }, { x: ix, y: h - iy }];
        }
        syncQuadFromSrc();
        resultPreview = null;
      }

      function setMode(next) {
        if (mode === next) return;
        mode = next;
        view = 'edit';
        resultPreview = null;
        // First time into document mode, look for the edges rather than making
        // the user place all four corners by hand.
        if (mode === 'doc' && !quadSrc) runDetection();
        syncControls();
        draw();
      }

      function setScan(next) {
        if (scanMode === next) return;
        scanMode = next;
        resultPreview = null;
        syncControls();
        buildStageBase();
        draw();
      }

      // The stage image: the rotated photo at preview size with the scan filter
      // already applied, so the filter is judged on screen and not just on
      // attach. Cached because it only changes with rotation or filter, never
      // while a corner or crop edge is being dragged.
      function buildStageBase() {
        const c = document.createElement('canvas');
        c.width = stageW; c.height = stageH;
        c.getContext('2d').drawImage(rc, 0, 0, rc.width, rc.height, 0, 0, stageW, stageH);
        try { enhanceDocument(c, scanMode); } catch { /* keep the unfiltered stage */ }
        stageBase = c;
      }

      // Reflect mode / filter / view in the controls and the hint line.
      function syncControls() {
        $$('#phModeSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === mode));
        $$('#phScanSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === scanMode));
        docRow.hidden = mode !== 'doc';
        quadEl.hidden = mode !== 'doc' || view !== 'edit';
        cropEl.hidden = mode !== 'rect' || view !== 'edit';
        $('#phPreview').textContent = view === 'result' ? t('Back to editing') : t('Preview result');
        const note = $('#phDocNote');
        if (mode === 'doc') {
          note.textContent = detected
            ? t('Edges detected — drag the corners to adjust.')
            : t('No edges found — drag the corners onto the receipt.');
          note.classList.toggle('ok', !!detected);
        }
      }

      function clampCrop() {
        const min = 28;
        crop.w = Math.max(min, Math.min(crop.w, stageW));
        crop.h = Math.max(min, Math.min(crop.h, stageH));
        crop.x = Math.max(0, Math.min(crop.x, stageW - crop.w));
        crop.y = Math.max(0, Math.min(crop.y, stageH - crop.h));
      }

      // Worst case the strip can grow to at width `w`: timestamp + two wrapped
      // address rows + coordinates. Reserved up front so the photo is fitted
      // with the strip already accounted for.
      const bandReserve = w => captureStampHeight(canvas.getContext('2d'), w,
        [{ text: 'Ag', bold: true }, { text: 'Ag' }, { text: 'Ag' }, { text: 'Ag' }]);

      // The modal's real width is only known once the browser has laid it out
      // (and it changes when the window resizes), so re-fit whenever it moves.
      let fittedTo = 0;
      const stageRO = new ResizeObserver(() => {
        const w = stageEl.parentElement.clientWidth;
        if (w && Math.abs(w - fittedTo) > 1) { fittedTo = w; layout(true); }
      });
      stageRO.observe(stageEl.parentElement);

      // Current stamp lines (empty when the stamp is switched off).
      function stampLines() {
        if (!stampOn) return [];
        const lines = [{ text: fmtStampTime(new Date(shotAt)), bold: true }];
        if (geo) {
          if (geo.address) lines.push({ text: geo.address });
          lines.push({ text: `${fmtLat(geo.lat)}  ${fmtLon(geo.lon)}  ±${Math.round(geo.acc)} m` });
        } else if (geoStatus === 'locating') {
          lines.push({ text: t('Locating…') });
        } else if (geoStatus === 'denied') {
          lines.push({ text: t('Location unavailable') });
        }
        return lines;
      }

      // Where the stamp band hangs in the preview: under the kept area, as wide
      // as it is. In document mode that is the deskewed page, approximated on
      // screen by the quad's bounding box.
      function bandBox() {
        if (mode !== 'doc' || !quad) return { x: crop.x, y: crop.y + crop.h, w: crop.w };
        const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
        return { x: Math.min(...xs), y: Math.max(...ys), w: Math.max(...xs) - Math.min(...xs) };
      }

      function draw() {
        const ctx = canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, stageW, stageH);
        if (view === 'result') { drawResult(ctx); renderStampInfo(); return; }
        ctx.drawImage(stageBase, 0, 0);
        if (mode === 'doc' && quad) drawQuad(ctx);
        drawStampBar();
        cropEl.style.left = crop.x + 'px';
        cropEl.style.top = crop.y + 'px';
        cropEl.style.width = crop.w + 'px';
        cropEl.style.height = crop.h + 'px';
        renderStampInfo();
      }

      // The four-corner overlay: everything outside the quad dimmed, the page
      // outlined, and the handles parked on the corners.
      function drawQuad(ctx) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, stageW, stageH);
        ctx.moveTo(quad[0].x, quad[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(quad[i].x, quad[i].y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(10,10,12,.5)';
        ctx.fill('evenodd');
        ctx.beginPath();
        ctx.moveTo(quad[0].x, quad[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(quad[i].x, quad[i].y);
        ctx.closePath();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,255,255,.95)';
        ctx.stroke();
        ctx.restore();
        $$('.ph-qh', quadEl).forEach(el => {
          const p = quad[+el.dataset.q];
          el.style.left = p.x + 'px';
          el.style.top = p.y + 'px';
        });
      }

      // The finished image, fitted into the stage so switching views never
      // reflows the modal around a different aspect ratio.
      function drawResult(ctx) {
        if (!resultPreview) {
          try { resultPreview = renderOutput(560); }
          catch { resultPreview = null; }
        }
        ctx.fillStyle = '#26262a';
        ctx.fillRect(0, 0, stageW, stageH);
        if (!resultPreview) return;
        const s = Math.min(stageW / resultPreview.width, stageH / resultPreview.height);
        const w = Math.max(1, Math.round(resultPreview.width * s));
        const h = Math.max(1, Math.round(resultPreview.height * s));
        ctx.drawImage(resultPreview, Math.round((stageW - w) / 2), Math.round((stageH - h) / 2), w, h);
        $('#phStampBar').style.display = 'none';
        stageEl.style.paddingBottom = '';
      }

      // Preview the stamp as the strip that will sit *below* the cropped photo:
      // same width as the crop, hung off its bottom edge, covering nothing.
      function drawStampBar() {
        const bar = $('#phStampBar');
        const lines = stampLines();
        const box = bandBox();
        const w = Math.max(1, Math.round(box.w));
        const h = captureStampHeight(bar.getContext('2d'), w, lines);
        if (!h) { bar.style.display = 'none'; stageEl.style.paddingBottom = ''; return; }
        bar.width = w; bar.height = h;
        bar.style.display = 'block';
        bar.style.width = w + 'px';
        bar.style.height = h + 'px';
        bar.style.left = Math.round(box.x) + 'px';
        bar.style.top = Math.round(box.y) + 'px';
        drawCaptureStamp(bar.getContext('2d'), 0, 0, w, lines);
        // Give the stage room when the strip hangs past the photo's bottom edge.
        const spill = Math.max(0, Math.round(box.y) + h - stageH);
        stageEl.style.paddingBottom = (GUTTER + spill) + 'px';
      }

      function renderStampInfo() {
        const el = $('#phStampInfo');
        if (!stampOn) { el.innerHTML = `<span class="muted">${esc(t('No stamp will be added.'))}</span>`; return; }
        const loc = geo
          ? (geo.address ? esc(geo.address) : `${esc(fmtLat(geo.lat))} ${esc(fmtLon(geo.lon))}`)
          : geoStatus === 'locating' ? esc(t('Locating…'))
          : geoStatus === 'denied' ? esc(t('Location unavailable'))
          : '';
        el.innerHTML = `<strong>📅 ${esc(fmtStampTime(new Date(shotAt)))}</strong>`
          + (loc ? `<span>📍 ${loc}</span>` : '');
      }

      // Ask for location the first time the stamp is (or stays) enabled.
      function ensureGeo() {
        if (!stampOn || geoStatus !== 'idle') return;
        geoStatus = 'locating'; renderStampInfo(); draw();
        getPositionOnce({ enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 })
          .then(async pos => {
            geo = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy || 0 };
            geoStatus = 'located'; draw();
            const addr = await reverseGeocode(geo.lat, geo.lon);
            if (addr && geo) { geo.address = addr; draw(); }
          })
          .catch(() => { geoStatus = 'denied'; draw(); });
      }

      // -- Crop drag/resize (pointer events, touch-friendly) --
      let drag = null;
      function stagePoint(e) {
        const r = canvas.getBoundingClientRect(); // crop coords share the canvas origin
        const z = r.width / stageW || 1;          // account for the page's CSS zoom
        return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
      }
      function onDown(e, mode, handle) {
        e.preventDefault();
        const p = stagePoint(e);
        drag = { mode, handle, sx: p.x, sy: p.y, orig: { ...crop } };
        try { e.target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
      function onMove(e) {
        if (!drag) return;
        const p = stagePoint(e);
        const dx = p.x - drag.sx, dy = p.y - drag.sy, o = drag.orig, min = 28;
        if (drag.mode === 'corner') {
          const c = quad[drag.handle];
          c.x = Math.max(0, Math.min(o.x + dx, stageW));
          c.y = Math.max(0, Math.min(o.y + dy, stageH));
          const k = rc.width / stageW;
          quadSrc[drag.handle] = rcToSrc({ x: c.x * k, y: c.y * k });
          resultPreview = null;
          draw();
          drawLoupe(c);
          return;
        }
        if (drag.mode === 'move') {
          crop.x = Math.max(0, Math.min(o.x + dx, stageW - o.w));
          crop.y = Math.max(0, Math.min(o.y + dy, stageH - o.h));
        } else {
          let x = o.x, y = o.y, w = o.w, h = o.h;
          const H = drag.handle;
          if (H.includes('e')) w = Math.max(min, Math.min(o.w + dx, stageW - o.x));
          if (H.includes('s')) h = Math.max(min, Math.min(o.h + dy, stageH - o.y));
          if (H.includes('w')) { const nx = Math.max(0, Math.min(o.x + dx, o.x + o.w - min)); w = o.w + (o.x - nx); x = nx; }
          if (H.includes('n')) { const ny = Math.max(0, Math.min(o.y + dy, o.y + o.h - min)); h = o.h + (o.y - ny); y = ny; }
          crop = { x, y, w, h };
        }
        draw();
      }
      function onUp() {
        if (drag && drag.mode === 'corner') loupeEl.style.display = 'none';
        drag = null;
      }

      // A loupe while a corner is dragged — under a fingertip the corner itself
      // is invisible, so show a magnified copy parked in the opposite half of
      // the frame, where the hand isn't.
      function drawLoupe(c) {
        const R = loupeEl.width, zoom = 3, span = R / zoom;
        const lx = c.x > stageW / 2 ? 8 : stageW - R - 8;
        const ly = c.y > stageH / 2 ? 8 : stageH - R - 8;
        loupeEl.style.left = lx + 'px';
        loupeEl.style.top = ly + 'px';
        loupeEl.style.display = 'block';
        const lc = loupeEl.getContext('2d');
        lc.clearRect(0, 0, R, R);
        lc.save();
        lc.beginPath();
        lc.arc(R / 2, R / 2, R / 2 - 1, 0, Math.PI * 2);
        lc.clip();
        lc.fillStyle = '#26262a';
        lc.fillRect(0, 0, R, R);
        lc.imageSmoothingEnabled = false;
        lc.drawImage(stageBase, c.x - span / 2, c.y - span / 2, span, span, 0, 0, R, R);
        lc.strokeStyle = 'rgba(255,255,255,.9)';
        lc.lineWidth = 1;
        lc.beginPath();
        lc.moveTo(R / 2, R / 2 - 14); lc.lineTo(R / 2, R / 2 + 14);
        lc.moveTo(R / 2 - 14, R / 2); lc.lineTo(R / 2 + 14, R / 2);
        lc.stroke();
        lc.restore();
      }

      cropEl.addEventListener('pointerdown', e => {
        if (e.target.classList.contains('ph-handle')) onDown(e, 'resize', e.target.dataset.h);
        else onDown(e, 'move', null);
      });
      quadEl.addEventListener('pointerdown', e => {
        const h = e.target.closest('.ph-qh');
        if (!h) return;
        const i = +h.dataset.q;
        onDown(e, 'corner', i);
        drag.orig = { ...quad[i] };
        drawLoupe(quad[i]);
      });
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      // Tidy the document-level listeners when the editor closes.
      const cleanup = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        stageRO.disconnect();
      };

      // -- Controls --
      const dial = $('#phDial'), knob = $('#phDialKnob'), dialVal = $('#phDialVal');
      // Reflect the current angle on the dial: centre readout + knob on the ring.
      function updateDial() {
        const disp = displayAngle();
        dialVal.textContent = `${Math.round(disp)}°`;
        dial.setAttribute('aria-valuenow', String(Math.round(disp)));
        const c = dial.clientWidth / 2 || 52, R = c - 11;
        const rad = (disp - 90) * Math.PI / 180; // -90 so 0° sits at the top
        knob.style.left = (c + R * Math.cos(rad)) + 'px';
        knob.style.top = (c + R * Math.sin(rad)) + 'px';
      }
      // Pointer angle around the dial centre, mapped so straight-up is 0°.
      function dialAngle(e) {
        const r = dial.getBoundingClientRect();
        let d = Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI + 90;
        d = ((d % 360) + 540) % 360 - 180;              // → -180..180
        for (const s of [-180, -90, 0, 90, 180]) if (Math.abs(d - s) <= 2.5) d = s; // snap to right angles
        return d;
      }
      let dialDrag = false;
      dial.addEventListener('pointerdown', e => {
        e.preventDefault(); dialDrag = true;
        try { dial.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        angle = dialAngle(e); updateDial(); layout(true);
      });
      dial.addEventListener('pointermove', e => { if (dialDrag) { angle = dialAngle(e); updateDial(); layout(true); } });
      const endDial = () => { dialDrag = false; };
      dial.addEventListener('pointerup', endDial);
      dial.addEventListener('pointercancel', endDial);
      dial.addEventListener('keydown', e => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { angle -= 1; updateDial(); layout(true); e.preventDefault(); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { angle += 1; updateDial(); layout(true); e.preventDefault(); }
      });

      $('#phRotL').addEventListener('click', () => { angle -= 90; updateDial(); layout(true); });
      $('#phRotR').addEventListener('click', () => { angle += 90; updateDial(); layout(true); });
      $('#phReset').addEventListener('click', () => { angle = 0; updateDial(); layout(true); });
      $('#phStamp').addEventListener('change', e => {
        stampOn = e.target.checked;
        if (stampOn) ensureGeo();
        draw();
      });
      $('#phModeSeg').addEventListener('click', e => {
        const b = e.target.closest('button');
        if (b) setMode(b.dataset.v);
      });
      $('#phScanSeg').addEventListener('click', e => {
        const b = e.target.closest('button');
        if (b) setScan(b.dataset.v);
      });
      $('#phDetect').addEventListener('click', () => {
        runDetection();
        view = 'edit';
        syncControls();
        draw();
        if (!detected) toast(t("Couldn't find the edges — place the corners by hand"), true);
      });
      $('#phPreview').addEventListener('click', () => {
        view = view === 'result' ? 'edit' : 'result';
        syncControls();
        draw();
      });

      // Build the finished image: crop (or deskew), clean up, then hang the
      // stamp band underneath. Shared by the on-screen preview and the export,
      // so what the user approves is what gets attached.
      function renderOutput(cap) {
        const sc = rc.width / stageW;                     // stage px → full-res px
        let body;
        if (mode === 'doc' && quad) {
          const full = quad.map(p => ({
            x: Math.max(0, Math.min(rc.width, p.x * sc)),
            y: Math.max(0, Math.min(rc.height, p.y * sc))
          }));
          const size = quadOutputSize(full, cap);
          body = warpQuad(rc, full, size.w, size.h);
          if (!body) throw new Error('warp failed');
        } else {
          const cw = Math.max(1, Math.round(crop.w * sc)), ch = Math.max(1, Math.round(crop.h * sc));
          const s = Math.min(1, cap / Math.max(cw, ch));
          body = document.createElement('canvas');
          body.width = Math.max(1, Math.round(cw * s));
          body.height = Math.max(1, Math.round(ch * s));
          body.getContext('2d').drawImage(rc, crop.x * sc, crop.y * sc, cw, ch, 0, 0, body.width, body.height);
        }
        enhanceDocument(body, scanMode);
        const cnv = document.createElement('canvas');
        const cx = cnv.getContext('2d');
        const lines = stampLines();
        // The stamp gets its own band beneath the photo, so the picture itself
        // is never covered.
        const bandH = captureStampHeight(cx, body.width, lines);
        cnv.width = body.width; cnv.height = body.height + bandH;
        cx.drawImage(body, 0, 0);
        drawCaptureStamp(cx, 0, body.height, body.width, lines);
        return cnv;
      }

      const cancel = () => { cleanup(); settle(null); };
      $('#phCancel').addEventListener('click', cancel);
      $('#phCancelX').addEventListener('click', cancel);
      $('#phAttach').addEventListener('click', async () => {
        cleanup();
        try {
          // A plain box crop with no filter is a straight copy, so it keeps the
          // photo's own resolution. The deskew and the filter both cost a pass
          // per pixel, so those are capped — well past what a receipt needs to
          // stay readable, and small enough not to strain a phone.
          const cap = (mode === 'doc' || scanMode !== 'off') ? 2600 : Infinity;
          const cnv = renderOutput(cap);
          const blob = await new Promise(res => cnv.toBlob(res, 'image/jpeg', 0.92));
          if (!blob) throw new Error('encode failed');
          const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
          settle(new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() }));
        } catch {
          toast(t("Couldn't process the photo — attaching the original"), true);
          settle(file);
        }
      });

      layout(true);
      // Detection has already run as part of the first layout. When it found a
      // page, open on the four-corner view so the straightened crop is the
      // thing being reviewed — the user still has to press Attach, and one tap
      // puts them back on the plain rectangle.
      if (detected) mode = 'doc';
      syncControls();
      draw();
      updateDial();
      ensureGeo();
    }
  });
}

// Validate, HEIC-convert and compress a picked file list into accepted File[].
// `alreadyCount` is the row's current file count, so it can't exceed 8.
async function processFiles(list, alreadyCount = 0) {
  const out = [];
  for (const f of Array.from(list)) {
    if (alreadyCount + out.length >= 8) { toast(t('Maximum 8 files'), true); break; }
    if (!isAllowedUpload(f)) { toast(t('{name}: only PDF or image files are allowed', { name: f.name }), true); continue; }
    let file = f;
    // iPhone HEIC/HEIF photos aren't viewable in browsers, so convert them to
    // JPEG up front (regardless of size) before the 10 MB check below.
    if (isHeic(file)) {
      toast(t('Converting {name}…', { name: f.name }));
      try { file = await heicToJpeg(file); }
      catch { toast(t("{name}: couldn't read this iPhone photo", { name: f.name }), true); continue; }
    }
    // Every still image opens the crop / rotate / stamp editor before it is
    // compressed. Animated GIFs and PDFs skip it (nothing to crop, and re-encoding
    // would flatten a GIF). A null result means the user cancelled — drop it.
    const editable = file.type && file.type.startsWith('image/') && file.type !== 'image/gif';
    if (editable) {
      const edited = await editImage(file);
      if (!edited) continue; // cancelled in the editor
      file = edited;
    }
    // Compress images down to the same-origin upload capacity so they take the
    // reliable path through our own domain. Modern phone photos are often 4–8 MB,
    // which would otherwise route to the vercel.com direct-upload host that some
    // networks block. PDFs and animated GIFs can't be re-encoded.
    const compressible = file.type && file.type.startsWith('image/') && file.type !== 'image/gif';
    if (compressible && file.size > COMPRESS_TARGET) {
      toast(t('Compressing {name}…', { name: f.name }));
      try { file = await compressImage(file, COMPRESS_TARGET); }
      catch { toast(t("{name}: couldn't compress — please shrink it and retry", { name: f.name }), true); continue; }
    }
    if (file.size > MAX_UPLOAD) { toast(t('{name} exceeds 10 MB', { name: f.name }), true); continue; }
    out.push(file);
  }
  return out;
}

// Same intake as processFiles, but for a cash-advance request's supporting
// documents: every accepted file leaves as a PDF. A PDF is taken as-is; an
// image (including an iPhone HEIC) is converted, so finance receives one
// format it can open, print and staple to the voucher regardless of what the
// requester had on their phone. No photo editor here — these are documents
// (a quotation, a proforma invoice), not receipts needing a capture stamp.
async function processAdvanceDocs(list, alreadyCount = 0) {
  const out = [];
  for (const f of Array.from(list)) {
    if (alreadyCount + out.length >= 8) { toast(t('Maximum 8 files'), true); break; }
    if (!isAllowedUpload(f)) { toast(t('{name}: only PDF or image files are allowed', { name: f.name }), true); continue; }
    let file = f;
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
      if (file.size > MAX_UPLOAD) { toast(t('{name} exceeds 10 MB', { name: f.name }), true); continue; }
      out.push(file);
      continue;
    }
    if (isHeic(file)) {
      try { file = await heicToJpeg(file); }
      catch { toast(t("{name}: couldn't read this iPhone photo", { name: f.name }), true); continue; }
    }
    // Shrink before wrapping: embedJpg keeps the photo's own bytes, so a
    // compressed photo is what keeps the PDF under the upload cap.
    if (file.size > COMPRESS_TARGET && file.type !== 'image/gif') {
      try { file = await compressImage(file, COMPRESS_TARGET); }
      catch { toast(t("{name}: couldn't compress — please shrink it and retry", { name: f.name }), true); continue; }
    }
    toast(t('Converting {name} to PDF…', { name: f.name }));
    try { file = await imageToPdfFile(file); }
    catch { toast(t("{name}: couldn't be converted to PDF", { name: f.name }), true); continue; }
    if (file.size > MAX_UPLOAD) { toast(t('{name} exceeds 10 MB', { name: f.name }), true); continue; }
    out.push(file);
  }
  return out;
}
// Chips for the claim's receipts: the ones already saved (openable, so the
// claimant can check what is there before replacing it) followed by the files
// picked in this session. Removing either kind is what drops it from the claim.
function renderChips() {
  const saved = keptAttachments.map((a, i) =>
    `<span class="file-chip file-chip-saved">
      <a href="/api/claims/${keptClaimId}/attachments/${a.id}" target="_blank" rel="noopener">${esc(a.original_name)}</a>
      <button type="button" data-kind="kept" data-i="${i}" aria-label="${esc(t('Remove'))} ${esc(a.original_name)}">×</button>
    </span>`);
  const picked = pendingFiles.map((f, i) =>
    `<span class="file-chip">${esc(f.name)}
      <button type="button" data-kind="new" data-i="${i}" aria-label="${esc(t('Remove'))} ${esc(f.name)}">×</button>
    </span>`);
  $('#fileChips').innerHTML = saved.concat(picked).join('');
  $$('#fileChips button').forEach(b => b.addEventListener('click', () => {
    (b.dataset.kind === 'kept' ? keptAttachments : pendingFiles).splice(+b.dataset.i, 1);
    renderChips();
  }));
}

// Send an in-memory blob via XMLHttpRequest, resolving with the parsed JSON
// response. We use XHR rather than fetch() because iOS Safari reports upload
// failures as an opaque "Load failed" with no detail; XHR distinguishes
// network / timeout / HTTP-status errors and reports upload progress.
function xhrSend(method, url, body, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    // Note: no withCredentials — same-origin requests send the session cookie
    // automatically, and the cross-origin Blob PUT must stay credential-less
    // (its response uses a wildcard CORS origin, which credentials would block).
    xhr.setRequestHeader('content-type', contentType || 'application/octet-stream');
    xhr.timeout = 120000; // 2 min — generous for a large photo on mobile data
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('the upload response could not be read')); }
      } else {
        let msg = `the server returned ${xhr.status}`;
        try { const j = JSON.parse(xhr.responseText); if (j && j.error) msg = t(j.error); } catch { /* keep default */ }
        // Attach the status (and any Retry-After) so the caller can tell a
        // transient 429 rate-limit apart from a deterministic 4xx/5xx.
        const err = new Error(msg);
        err.status = xhr.status;
        const ra = xhr.getResponseHeader('retry-after');
        if (ra) err.retryAfter = ra;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('a network error interrupted the upload'));
    xhr.ontimeout = () => reject(new Error('the upload timed out'));
    xhr.onabort = () => reject(new Error('the upload was cancelled'));
    xhr.send(body);
  });
}

// Files at or under this size upload through our own origin (reliable); larger
// files must go directly to Blob to clear the serverless ~4.5 MB body limit.
const DIRECT_BLOB_THRESHOLD = 4 * 1024 * 1024;

// Parse a Retry-After header (delta-seconds or an HTTP-date) into milliseconds,
// or null when it is absent or unparseable.
function retryAfterMs(v) {
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(v);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// Upload one already-materialized receipt. A network blip or timeout is worth
// exactly one retry; an HTTP 429 (rate limiting — Vercel's edge throttles the
// burst of back-to-back receipt uploads) is transient too, so we retry it a few
// times with exponential backoff, honoring a Retry-After header when present.
// Every other HTTP-status and bad-response error is deterministic and rethrown.
async function sendReceipt(method, url, body, contentType, onProgress) {
  const MAX_429_RETRIES = 3;
  let rateLimitTries = 0, netTries = 0;
  for (;;) {
    try {
      return await xhrSend(method, url, body, contentType, onProgress);
    } catch (e) {
      if (e.status === 429 && rateLimitTries < MAX_429_RETRIES) {
        rateLimitTries++;
        const server = retryAfterMs(e.retryAfter);
        // Fall back to 1s / 2s / 4s backoff with jitter when the server gives
        // no Retry-After, so parallel uploads don't all wake at once.
        const backoff = Math.min(8000, 1000 * 2 ** (rateLimitTries - 1)) + Math.random() * 250;
        await wait(server === null ? backoff : server);
        continue;
      }
      if (/network error|timed out/.test(e.message) && netTries < 1) {
        netTries++;
        continue;
      }
      throw e;
    }
  }
}

// Upload the chosen receipts and return the metadata to attach to the claim.
// Small files (the common case — phone photos, most PDFs) go through our own
// domain, which is reliable everywhere the app itself loads. Only genuinely
// large files use a presigned direct-to-Blob URL, since they can't fit through
// the size-limited API route. Files are already compressed/validated by addFiles().
async function uploadReceipts(files, onProgress) {
  if (!files.length) return [];
  // Presign only the large files that must bypass our API route.
  const large = files.map((f, i) => ({ f, i })).filter(x => x.f.size > DIRECT_BLOB_THRESHOLD);
  const presigned = {};
  if (large.length) {
    const { uploads } = await api('/uploads/presign', {
      method: 'POST',
      body: JSON.stringify({ files: large.map(x => ({ name: x.f.name, type: x.f.type, size: x.f.size })) })
    });
    large.forEach((x, k) => { presigned[x.i] = uploads[k].presignedUrl; });
  }
  const out = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const prog = onProgress ? frac => onProgress(i, files.length, frac) : null;
    // iOS Safari can fail to stream a File backed by a fresh camera capture, so
    // read the bytes into an in-memory Blob first (the same read the compression
    // path does), which sidesteps that bug.
    const type = f.type || 'application/octet-stream';
    const body = new Blob([await f.arrayBuffer()], { type });
    const viaDirect = f.size > DIRECT_BLOB_THRESHOLD;
    let blob;
    try {
      blob = viaDirect
        ? await sendReceipt('PUT', presigned[i], body, type, prog)
        : await sendReceipt('POST', `/api/uploads/direct?name=${encodeURIComponent(f.name)}&type=${encodeURIComponent(type)}`, body, type, prog);
    } catch (e) {
      // The trailing tag names which path failed, to aid diagnosis: "storage
      // host" = the direct vercel.com upload (large files); "our server" = the
      // same-origin API route (small files).
      throw new Error(`Couldn't upload ${f.name} via ${viaDirect ? 'storage host' : 'our server'} — ${e.message}. Please retry.`);
    }
    out.push({ url: blob.url, original_name: f.name });
  }
  return out;
}

async function submitClaim(e, existing, reclaim = null) {
  e.preventDefault();
  readClaimRows();
  const err = $('#claimError'); err.hidden = true;
  // Keep only rows the claimant actually filled in (any field or receipt).
  const rows = claimRows.filter(r =>
    r.line_date || r.db_no || String(r.expense_type || '').trim() || r.description
    || rcAmt(r.amount) || (r.files || []).length || (r.kept || []).length);
  if (!rows.length) { err.textContent = t('Add at least one expense line with a date, type and amount.'); err.hidden = false; return; }
  // Resolve each row's expense type ("Others" uses its specify field).
  const rowType = (r) => r.expense_type === 'Others' ? String(r.expense_type_other || '').trim() : String(r.expense_type || '').trim();
  for (const r of rows) {
    if (!r.line_date) { flagClaimRow(err, r, t('Enter the date.'), 'line_date'); return; }
    if (r.expense_type === 'Others' && !String(r.expense_type_other || '').trim()) {
      flagClaimRow(err, r, t('Specify the type of expense.'), 'expense_type_other'); return;
    }
    if (!rowType(r)) { flagClaimRow(err, r, t('Choose the type of expense.'), 'expense_type'); return; }
    if (rcAmt(r.amount) <= 0) { flagClaimRow(err, r, t('Enter an amount above 0.'), 'amount'); return; }
  }
  // Claim-date policy: block any row dated in the future, or before the allowed
  // floor — except the dates this claim already carried in (setClaimDateCarried).
  const dateErr = claimDatesError(rows.map(r => r.line_date));
  if (dateErr) { err.textContent = dateErr; err.hidden = false; return; }
  const approver1 = String((new FormData(e.target).get('approver1') || '')).trim();
  if ((state.user.approver1_choices || []).length >= 2 && !approver1) {
    err.textContent = t('Please choose Approver 1.'); err.hidden = false; return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  const label = btn.textContent;
  btn.disabled = true;
  try {
    // Upload each row's receipts to Blob, then send the claim as JSON carrying
    // only their metadata (keeping large files off the size-limited API route).
    if (rows.some(r => (r.files || []).length)) btn.textContent = t('Uploading receipts…');
    const lines = [];
    for (const r of rows) {
      const uploaded = (r.files || []).length ? await uploadReceipts(r.files) : [];
      lines.push({
        line_date: r.line_date, db_no: r.db_no, expense_type: rowType(r),
        amount: r.amount, description: r.description,
        attachments: uploaded, keep_attachment_ids: (r.kept || []).map(a => a.id)
      });
    }
    const payload = { lines, currency: regionCurrency() };
    if (approver1) payload.approver1 = Number(approver1);
    btn.textContent = existing ? t('Resubmitting…') : t('Submitting…');
    if (existing) {
      payload.resubmit_note = String((new FormData(e.target).get('resubmit_note') || '')).trim();
      await api('/claims/' + existing.id, { method: 'PUT', body: JSON.stringify(payload) });
      toast(t('Claim resubmitted'));
    } else {
      if (reclaim) payload.source = { type: reclaim.type, id: reclaim.id, line_ids: reclaim.lines.map(l => l.id) };
      await api('/claims', { method: 'POST', body: JSON.stringify(payload) });
      toast(t('Claim submitted'));
      if (!reclaim) clearDraft('claim');
    }
    modalCloseHook = null; // submitted — don't auto-save a draft on close
    closeModal(); closeDrawer(); loadAll();
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
    btn.disabled = false; btn.textContent = label;
  }
}

$('#newClaimBtn').addEventListener('click', () => {
  // The button is disabled while held, so this is a backstop for any other way
  // in (keyboard, an extension, a stale page). Only the NEW path is held —
  // openClaimModal(existing) is edit-and-resubmit, which must always work.
  if (advanceHold()) return toast(advanceHoldReason(), true);
  openClaimModal();
});
