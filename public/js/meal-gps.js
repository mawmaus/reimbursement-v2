'use strict';

// New / edit GPS meal allowance (effective 2026-11-01; lib/meal-gps.js holds
// the rules the server enforces). A plain <script> sharing globals with app.js
// (loaded after it; see index.html). Nothing here runs app code at load beyond
// wiring listeners — js/start.js boots the app once every script is in.
//
// One card per day: in town or out of town, where the claimant was (browser
// GPS, measured against the base on their account), the meal amount(s) and the
// receipts. Every hint here is a preview; the server re-checks all of it.

const MG_KIND = 'mealgps';
const MG_MEALS = ['Breakfast', 'Lunch', 'Dinner'];
let mgRows = [];
let mgEditId = null;   // the claim being resubmitted (kept receipts link to it)
let mgGeo = 'prompt';  // location permission: granted | prompt | denied | unsupported
let mgSites = [];      // pinned customer sites (Settings → Customer sites), for the DB field's hint

const mgCfg = () => (state.user && state.user.meal_gps) || { allowed: false, base: null, rules: null };
const mgRules = () => {
  const r = mgCfg().rules || {};
  return {
    from: r.effectiveFrom || '2026-11-01', minKm: r.minKm || 30, maxMeals: r.maxMeals || 3,
    inCap: (r.inTownCapCents || 3500000) / 100, outCap: (r.outOfTownCapCents || 12000000) / 100,
    maxAcc: r.maxAccuracyM || 1000
  };
};
const mgBlank = () => ({ date: '', trip: '', amount: '', meals: ['', '', ''], site: '', category: '', desc: '', gps: null, files: [], kept: [] });
const mgMapUrl = (p) => `https://www.google.com/maps?q=${encodeURIComponent(`${p.lat},${p.lng}`)}`;
// Straight-line distance in km (same formula as the server).
function mgDistanceKm(a, b) {
  const rad = (d) => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const mgKm = (km) => t('{km} km', { km: (Math.round(km * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 }) });
// The date a GPS fix was taken, in the region's time zone.
const mgFixDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: regionTimezone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

// The word RADIUS — bold and red — wherever a distance from the base shows: the
// limit is a straight-line radius around the base, not the road distance, and
// people kept reading it as the trip length. A translated string carries a
// {radius} slot that t() leaves alone; withRadius escapes it, then fills it.
const radiusTag = () => `<strong class="radius-tag">${esc(t('RADIUS'))}</strong>`;
const withRadius = (s) => esc(s).replace('{radius}', radiusTag());
const radiusNoteHtml = (min) => `<p class="radius-note">${withRadius(t('{radius} — not travel distance. The {min} km is a straight line from the base to where you are, not the road.', { min }))}</p>`;

// What one day amounts to and what is wrong with it, for the card and the total.
function mgCheck(r) {
  const R = mgRules();
  const base = mgCfg().base;
  const meals = r.trip === 'out_of_town' ? r.meals.map(mealAmount).filter(n => n > 0) : [];
  const sum = r.trip === 'out_of_town' ? meals.reduce((s, n) => s + n, 0) : mealAmount(r.amount);
  const km = r.gps && base ? mgDistanceKm(base, r.gps) : null;
  const errs = [], warns = [];
  if (r.date && r.date < R.from) errs.push(t('The GPS meal allowance starts on {date}.', { date: R.from }));
  if (!r.trip) errs.push(t('Choose in town or out of town.'));
  if (!r.gps) errs.push(t('Record your location for this day.'));
  else if (r.gps.accuracy > R.maxAcc) errs.push(t('Your location is only accurate to {km} — turn on precise location / GPS and record it again.', { km: mgKm(r.gps.accuracy / 1000) }));
  const tooClose = r.trip === 'in_town' && km != null && km < R.minKm;
  if (tooClose) errs.push(t('You were {km} {radius} from {base} — in-town meals within {min} km can’t be claimed.', { km: mgKm(km), base: base.name || t('your base'), min: R.minKm }));
  if (r.trip === 'in_town' && !tooClose && sum > R.inCap) errs.push(t('In town is capped at {cap} a day.', { cap: money(R.inCap, regionCurrency()) }));
  if (r.trip === 'out_of_town' && sum > R.outCap) errs.push(t('Out of town is capped at {cap} a day for up to {n} meals.', { cap: money(R.outCap, regionCurrency()), n: R.maxMeals }));
  if (r.trip && !tooClose && !sum) errs.push(r.trip === 'out_of_town' ? t('Enter at least one meal amount.') : t('Enter the meal amount.'));
  if (!(r.files.length + r.kept.length)) errs.push(t('Attach the meal receipt.'));
  if (r.gps && r.date && r.gps.at && mgFixDate(r.gps.at) !== r.date) {
    warns.push(t('Location recorded on {date} — approvers see that it wasn’t taken on the day of the meal.', { date: mgFixDate(r.gps.at) }));
  }
  return { sum: tooClose ? 0 : sum, km, errs, warns, tooClose };
}
// A card counts as filled once anything beyond its (pre-filled) date is in it,
// and as touched — so its problems show — once the claimant typed or picked
// something themselves (an automatically recorded location doesn't count).
const mgTouched = (r) => !!(r.trip || mealAmount(r.amount) || r.meals.some(m => mealAmount(m)) || r.site || r.category || r.desc
  || r.files.length || r.kept.length);
const mgFilled = (r) => !!(r.trip || mealAmount(r.amount) || r.meals.some(m => mealAmount(m)) || r.site || r.category || r.desc
  || r.gps || r.files.length || r.kept.length);

// --- Location ---------------------------------------------------------------------
async function mgWatchPermission() {
  if (!navigator.geolocation) { mgGeo = 'unsupported'; return; }
  try {
    const p = await navigator.permissions.query({ name: 'geolocation' });
    mgGeo = p.state;
    p.onchange = () => { mgGeo = p.state; mgPaintGeoBanner(); };
  } catch { mgGeo = 'prompt'; } // Permissions API missing (older Safari): asking will tell
}
function mgPaintGeoBanner() {
  const box = $('#mgGeoBanner');
  if (!box) return;
  const msg = mgGeo === 'denied'
    ? t('Location is blocked for this site. Turn it on in your browser or phone settings (Allow location → Always / While using) — every day on this claim needs your location.')
    : mgGeo === 'unsupported' ? t('This browser can’t share your location. Use a phone or browser with location services to claim the GPS meal allowance.') : '';
  box.hidden = !msg;
  box.textContent = msg;
}
// Record the current position onto day `i`.
async function mgCapture(i, quiet = false) {
  const r = mgRows[i];
  if (!r) return;
  const btn = $(`#mgDays [data-gps="${i}"]`);
  if (btn) { btn.disabled = true; btn.textContent = t('Locating…'); }
  try {
    const pos = await getPositionOnce({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    r.gps = {
      lat: Math.round(pos.coords.latitude * 1e6) / 1e6, lng: Math.round(pos.coords.longitude * 1e6) / 1e6,
      accuracy: Math.round(pos.coords.accuracy || 0), at: new Date(pos.timestamp || Date.now()).toISOString()
    };
    if (mgGeo !== 'granted') { mgGeo = 'granted'; mgPaintGeoBanner(); }
  } catch (e) {
    if (e && e.code === 1) { mgGeo = 'denied'; mgPaintGeoBanner(); }
    if (!quiet) toast(e && e.code === 1 ? t('Location access was refused — allow it to record where you were.')
      : t('Couldn’t get your location — move to an open spot and try again.'), true);
  }
  mgReadRows(); mgRender();
}

// --- Cards ------------------------------------------------------------------------
function mgAmountField(name, value, label, i) {
  return `<label class="mg-amt">${esc(label)}
    <div class="amt-field"><span class="amt-cur">${esc(regionCurrency())}</span>
      <input name="${name}" inputmode="numeric" autocomplete="off" value="${esc(value ? groupAmount(String(value)) : '')}" placeholder="0" data-amt="${i}" /></div></label>`;
}
function mgLocationHtml(r, i, chk) {
  const base = mgCfg().base;
  if (!r.gps) {
    return `<div class="mg-loc mg-loc-none">
      <span class="mg-loc-ic" aria-hidden="true">📍</span>
      <div class="mg-loc-txt"><b>${esc(t('Location not recorded'))}</b><span>${esc(t('Record it where you had the meal.'))}</span></div>
      <button type="button" class="btn btn-primary btn-sm" data-gps="${i}">${esc(t('Record my location'))}</button>
    </div>`;
  }
  const cls = chk.tooClose ? 'mg-loc-bad' : 'mg-loc-ok';
  const dist = chk.km == null ? '' : `<span class="mg-dist">${withRadius(t('{km} {radius} from {base}', { km: mgKm(chk.km), base: (base && base.name) || t('base') }))}</span>`;
  return `<div class="mg-loc ${cls}">
    <span class="mg-loc-ic" aria-hidden="true">📍</span>
    <div class="mg-loc-txt">
      <b>${dist || esc(t('Location recorded'))}</b>
      <span>${esc(fmtDateTime(r.gps.at))}${r.gps.accuracy ? ` · ±${esc(String(r.gps.accuracy))}&nbsp;m` : ''} · <a href="${esc(mgMapUrl(r.gps))}" target="_blank" rel="noopener">${esc(t('Open in Maps'))}</a></span>
    </div>
    <button type="button" class="btn btn-ghost btn-sm" data-gps="${i}">${esc(t('Record again'))}</button>
  </div>`;
}
function mgChips(r, i) {
  const kept = r.kept.map((a, k) =>
    `<span class="file-chip file-chip-saved"><a href="/api/meal-claims/${mgEditId}/attachments/${a.id}" target="_blank" rel="noopener">${esc(a.original_name)}</a>` +
    `<button type="button" data-chip="kept" data-row="${i}" data-k="${k}" aria-label="${esc(t('Remove'))}">×</button></span>`);
  const files = r.files.map((f, k) =>
    `<span class="file-chip">${esc(f.name)}<button type="button" data-chip="new" data-row="${i}" data-k="${k}" aria-label="${esc(t('Remove'))}">×</button></span>`);
  return kept.concat(files).join('');
}
function mgDayHtml(r, i) {
  const R = mgRules();
  const chk = mgCheck(r);
  const amounts = r.trip === 'out_of_town'
    ? `<div class="mg-meals">${MG_MEALS.slice(0, R.maxMeals).map((m, k) => mgAmountField(`meal${k}`, r.meals[k], t(m), i)).join('')}</div>
       <p class="mg-cap">${esc(t('Up to {n} meals, {cap} a day in total.', { n: R.maxMeals, cap: money(R.outCap, regionCurrency()) }))}</p>`
    : r.trip === 'in_town'
      ? `<div class="mg-meals mg-meals-one">${mgAmountField('amount', r.amount, t('Meal amount'), i)}</div>
         <p class="mg-cap">${withRadius(t('{min} km {radius} or more from your base: up to {cap} a day.', { min: R.minKm, cap: money(R.inCap, regionCurrency()) }))}</p>`
      : '';
  return `<article class="mg-day${chk.errs.length && mgTouched(r) ? ' has-err' : ''}" data-i="${i}">
    <header class="mg-day-head">
      <span class="mg-day-n">${esc(t('Day {n}', { n: i + 1 }))}</span>
      <span class="mg-day-sum" data-sum="${i}">${chk.sum ? esc(money(chk.sum, regionCurrency())) : ''}</span>
      <button type="button" class="x-btn" data-rm="${i}" aria-label="${esc(t('Remove'))}">×</button>
    </header>
    <div class="mg-row">
      <label class="mg-date">${reqLabel(t('Date'))}${mgDateInput(r)}</label>
      <div class="mg-trip"><span class="lbl">${esc(t('Trip'))} <span class="req" aria-hidden="true">*</span></span>
        <div class="ph-seg" role="radiogroup" aria-label="${esc(t('Trip'))}">
          <button type="button" role="radio" aria-checked="${r.trip === 'in_town'}" class="${r.trip === 'in_town' ? 'on' : ''}" data-trip="in_town" data-row="${i}">${esc(t('In town'))}<small>${esc(t('Dalam kota'))}</small></button>
          <button type="button" role="radio" aria-checked="${r.trip === 'out_of_town'}" class="${r.trip === 'out_of_town' ? 'on' : ''}" data-trip="out_of_town" data-row="${i}">${esc(t('Out of town'))}<small>${esc(t('Luar kota'))}</small></button>
        </div></div>
    </div>
    ${mgLocationHtml(r, i, chk)}
    ${amounts}
    <div class="mg-receipts">
      <span class="lbl">${esc(t('Receipts'))} <span class="req" aria-hidden="true">*</span></span>
      <div class="mg-receipt-row"><div class="file-chips">${mgChips(r, i)}</div>
        <button type="button" class="btn btn-ghost btn-sm rc-cam" data-add="${i}" data-cam>📷 ${esc(t('Take photo'))}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-add="${i}">📎 ${esc(t('Add receipt'))}</button></div>
      <input type="file" class="mg-input" data-input="${i}" multiple hidden accept=".pdf,image/*,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif" />
    </div>
    <div class="mg-extra">
      <label>${esc(t('DB Number Site'))}${dbCellHtml(r.site)}</label>
      <label>${esc(t('Job Category'))}<input name="category" value="${esc(r.category)}" placeholder="${esc(t('Install / Repair / Service…'))}" /></label>
      <label>${esc(t('Additional Description'))}<input name="desc" value="${esc(r.desc)}" placeholder="${esc(t('Surabaya'))}" /></label>
    </div>
    <div class="mg-site-wrap" data-site="${i}">${mgSiteHtml(r)}</div>
    <div class="mg-msgs" data-msgs="${i}">${mgMsgsHtml(r, chk)}</div>
  </article>`;
}
// What the DB number points at: a pinned customer site and how far it is from
// the base — known before anyone travels. Only a hint: the day is measured
// from the location recorded there.
function mgSiteHtml(r) {
  const site = siteForDb(mgSites, r.site), base = mgCfg().base, R = mgRules();
  if (!site) {
    // Quiet while the number is still being typed.
    const db = String(r.site || '').replace(/\D/g, '');
    return mgSites.length && db.length >= 6
      ? `<p class="mg-site mg-site-none">${esc(t('DB{db} has no pin yet — the distance shows once you record your location there.', { db }))}</p>`
      : '';
  }
  const where = `DB${esc(site.db_no)}${site.name ? ' · ' + esc(site.name) : ''}`;
  if (!base) return `<div class="mg-site"><span class="mg-site-ic" aria-hidden="true">📌</span><div class="mg-site-txt"><b>${where}</b></div></div>`;
  const km = kmBetween(base, site), inside = km < R.minKm;
  return `<div class="mg-site ${inside ? 'mg-site-in' : 'mg-site-out'}">
    <span class="mg-site-ic" aria-hidden="true">📌</span>
    <div class="mg-site-txt"><b>${withRadius(t('Customer site {km} {radius} from {base}', { km: mgKm(km), base: base.name || t('base') }))}</b>
      <span>${where} · ${esc(inside
        ? t('inside {min} km: in-town meals can’t be claimed', { min: R.minKm })
        : t('{min} km or more: in-town meals can be claimed', { min: R.minKm }))}</span></div>
  </div>`;
}
function mgPaintSite(i) {
  const box = $(`#mgDays [data-site="${i}"]`), r = mgRows[i];
  if (box && r) box.innerHTML = mgSiteHtml(r);
}
// The date picker: the claim window's bounds, but never before the GPS form
// starts (a carried date keeps its own value, as claimDateInput allows).
function mgDateInput(r) {
  const from = mgRules().from;
  const html = claimDateInput('date', r.date, r.carried);
  if (r.carried && r.date && r.date < from) return html;
  const m = html.match(/min="([^"]*)"/);
  if (!m) return html.replace('<input ', `<input min="${from}" `);
  return m[1] >= from ? html : html.replace(m[0], `min="${from}"`);
}
// Problems show once the claimant has put something in a day, so a fresh card isn't red.
function mgMsgsHtml(r, chk) {
  const errs = mgTouched(r) ? chk.errs : [];
  return errs.map(m => `<p class="mg-msg mg-msg-err">${withRadius(m)}</p>`).join('')
    + chk.warns.map(m => `<p class="mg-msg mg-msg-warn">${esc(m)}</p>`).join('');
}
// Copy the typed fields back into mgRows (gps / files / kept live only there).
function mgReadRows() {
  $$('#mgDays .mg-day').forEach(card => {
    const r = mgRows[+card.dataset.i]; if (!r) return;
    const g = (n) => { const el = card.querySelector(`[name="${n}"]`); return el ? el.value : null; };
    r.date = g('date') || '';
    if (g('amount') != null) r.amount = g('amount');
    [0, 1, 2].forEach(k => { const v = g(`meal${k}`); if (v != null) r.meals[k] = v; });
    r.site = dbCellRead(card); r.category = g('category') || ''; r.desc = g('desc') || '';
  });
}
function mgTotal() { return mgRows.reduce((s, r) => s + mgCheck(r).sum, 0); }
function mgPaintTotals() {
  $('#mgTotal').textContent = liveAmt(mgTotal());
  syncLineCount(mgRows.filter(mgFilled).length);
}
// Refresh one card's sum and messages without re-rendering it (keeps focus).
function mgPaintDay(i) {
  const r = mgRows[i]; if (!r) return;
  const chk = mgCheck(r);
  const card = $(`#mgDays .mg-day[data-i="${i}"]`); if (!card) return;
  card.querySelector(`[data-sum="${i}"]`).textContent = chk.sum ? money(chk.sum, regionCurrency()) : '';
  card.querySelector(`[data-msgs="${i}"]`).innerHTML = mgMsgsHtml(r, chk);
  card.classList.toggle('has-err', !!(chk.errs.length && mgTouched(r)));
  mgPaintTotals();
}
function mgRender() {
  const box = $('#mgDays');
  box.innerHTML = mgRows.map(mgDayHtml).join('');
  mgPaintTotals();
  box.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
    mgReadRows(); mgRows.splice(+b.dataset.rm, 1); if (!mgRows.length) mgRows.push(mgBlank()); mgRender();
  }));
  box.querySelectorAll('[data-trip]').forEach(b => b.addEventListener('click', () => {
    mgReadRows(); mgRows[+b.dataset.row].trip = b.dataset.trip; mgRender();
    const f = $(`#mgDays .mg-day[data-i="${b.dataset.row}"] [data-amt]`); if (f) f.focus();
  }));
  box.querySelectorAll('[data-gps]').forEach(b => b.addEventListener('click', () => { mgReadRows(); mgCapture(+b.dataset.gps); }));
  box.querySelectorAll('[data-amt]').forEach(inp => inp.addEventListener('input', () => {
    inp.value = groupAmount(inp.value); mgReadRows(); mgPaintDay(+inp.dataset.amt);
  }));
  box.querySelectorAll('input[name="date"]').forEach(inp => inp.addEventListener('change', () => {
    mgReadRows(); mgPaintDay(+inp.closest('.mg-day').dataset.i);
  }));
  box.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => {
    const inp = $(`#mgDays .mg-input[data-input="${b.dataset.add}"]`); if (inp) pickFiles(inp, b.hasAttribute('data-cam'));
  }));
  box.querySelectorAll('.mg-input').forEach(inp => inp.addEventListener('change', async () => {
    const r = mgRows[+inp.dataset.input]; if (!r) return;
    mgReadRows();
    const accepted = await processFiles(inp.files, r.files.length + r.kept.length);
    r.files = r.files.concat(accepted);
    mgRender();
  }));
  box.querySelectorAll('[data-chip]').forEach(b => b.addEventListener('click', () => {
    const r = mgRows[+b.dataset.row]; if (!r) return;
    mgReadRows(); (b.dataset.chip === 'kept' ? r.kept : r.files).splice(+b.dataset.k, 1); mgRender();
  }));
  wireDbCells('#mgDays');
  box.querySelectorAll('.mg-day .db-num, .mg-day .db-mode').forEach(inp => inp.addEventListener(inp.matches('select') ? 'change' : 'input', () => {
    mgReadRows(); mgPaintSite(+inp.closest('.mg-day').dataset.i); mgPaintMap();
  }));
  mgPaintMap();
}

// --- The form -----------------------------------------------------------------------
function mgBaseHtml() {
  const base = mgCfg().base;
  const R = mgRules();
  if (!base) {
    return `<p class="form-note caution mg-nobase">${esc(t('Your account has no base location yet. Ask your administrator to set it — until then this form can’t be submitted.'))}</p>`;
  }
  return `<div class="mg-base">
    <span class="mg-base-ic" aria-hidden="true">🏢</span>
    <div><div class="mg-base-l">${esc(t('Your base'))}</div>
      <div class="mg-base-n">${esc(base.name || t('Base'))} · <a href="${esc(mgMapUrl(base))}" target="_blank" rel="noopener">${esc(t('Open in Maps'))}</a></div></div>
    ${radiusNoteHtml(R.minKm)}
    <ul class="mg-rules">
      <li>${withRadius(t('In town, within {min} km {radius}: not claimable', { min: R.minKm }))}</li>
      <li>${withRadius(t('In town, {min} km {radius} or more: up to {cap} a day', { min: R.minKm, cap: money(R.inCap, regionCurrency()) }))}</li>
      <li>${esc(t('Out of town: up to {n} meals, {cap} a day', { n: R.maxMeals, cap: money(R.outCap, regionCurrency()) }))}</li>
      <li>${esc(t('Every day needs your location and its receipt'))}</li>
    </ul>
  </div>
  <div class="mg-map-wrap">
    <div class="mg-map map-box" id="mgMap"><p class="map-msg">${esc(t('Loading map…'))}</p></div>
    <p class="map-key"><span class="map-key-ring" aria-hidden="true"></span>${withRadius(t('Your base and its {min} km {radius}', { min: R.minKm }))}
      <span class="map-key-pin" aria-hidden="true"></span>${esc(t('Where each day was recorded (numbered by day)'))}
      <span class="map-key-site big" aria-hidden="true"></span>${esc(t('The customer site of a day’s DB number'))}</p>
  </div>`;
}

// --- Map: the base, its ring and each day's recorded location (js/map.js) ----------
// Made once per form; mgRender repaints the pins. The view refits only when a
// location changes, so switching a trip type doesn't move the map.
let mgMap = null;
async function mgInitMap() {
  mgMap = null;
  const el = $('#mgMap'), base = mgCfg().base;
  if (!el || !base) return;
  const map = await makeMap(el);
  if (!map || el !== $('#mgMap')) return;
  mapBase(map, base, mgRules().minKm);
  mgMap = { map, el, sites: L.layerGroup().addTo(map), layer: L.layerGroup().addTo(map), sig: null };
  mgPaintMap();
}
function mgPaintMap() {
  if (!mgMap || !mgMap.el.isConnected) return;
  const base = mgCfg().base, R = mgRules();
  const points = [];
  mgRows.forEach((r, i) => {
    if (!r.gps) return;
    const chk = mgCheck(r);
    const where = chk.km == null ? esc(t('Location recorded'))
      : withRadius(t('{km} {radius} from {base}', { km: mgKm(chk.km), base: base.name || t('base') }));
    points.push({ lat: r.gps.lat, lng: r.gps.lng, n: i + 1, base, bad: chk.tooClose,
      popup: `<b>${esc(t('Day {n}', { n: i + 1 }))}${r.date ? ' · ' + esc(r.date) : ''}</b><br>${where}<br><span class="map-ll">${esc(fmtDateTime(r.gps.at))}</span>` });
  });
  mapPins(mgMap.layer, points);
  // The customer sites the days' DB numbers point at.
  const seen = new Set();
  const sites = mgRows.map(r => siteForDb(mgSites, r.site)).filter(s => s && !seen.has(s.id) && seen.add(s.id))
    .map(s => ({ lat: s.lat, lng: s.lng, big: true, base, popup: sitePopupHtml(s, base, R.minKm) }));
  mapSites(mgMap.sites, sites);
  const all = points.concat(sites);
  const sig = all.map(p => `${p.lat},${p.lng}`).join('|');
  if (sig !== mgMap.sig) {
    mgMap.sig = sig;
    fitAreas(mgMap.map, [ringArea(base, R.minKm), ...all.map(p => ringArea(p, 0.5))]);
  }
}
// Fields of one day as a draft (files go to IndexedDB separately).
const mgDraftRow = (r) => ({ date: r.date, trip: r.trip, amount: r.amount, meals: r.meals.slice(), site: r.site,
  category: r.category, desc: r.desc, gps: r.gps });
function collectMealGpsDraft() {
  mgReadRows();
  if (!mgRows.some(mgFilled)) return null;
  const approver1 = (($('#mgForm [name="approver1"]') || {}).value) || '';
  return { rows: mgRows.map(mgDraftRow), approver1 };
}
const collectMealGpsFiles = () => mgRows.map(r => r.files.slice());

async function openMealGpsModal(existing = null) {
  const isEdit = !!existing;
  mgEditId = isEdit ? existing.id : null;
  setClaimDateContext(isEdit ? existing : null);
  const fresh = !isEdit;
  const draft = fresh ? loadDraft(MG_KIND) : null;
  if (isEdit) {
    mgRows = activeLines(existing).map(l => {
      const meals = (l.meals || []).map(n => String(Math.round(n)));
      while (meals.length < 3) meals.push('');
      return {
        date: l.line_date, trip: l.trip_type || '', amount: l.trip_type === 'in_town' ? String(Math.round(l.amount)) : '',
        meals, site: l.site || '', category: l.job_category || '', desc: l.description || '',
        gps: l.gps ? { lat: l.gps.lat, lng: l.gps.lng, accuracy: l.gps.accuracy_m, at: l.gps.at } : null,
        files: [], kept: (l.attachments || []).slice(), carried: !claimDateUnlocked()
      };
    });
  } else if (draft && Array.isArray(draft.data.rows) && draft.data.rows.length) {
    const files = (await loadDraftFiles(MG_KIND)) || [];
    mgRows = draft.data.rows.map((d, i) => ({ ...mgBlank(), ...d, meals: (d.meals || ['', '', '']).slice(0, 3), files: files[i] || [], kept: [] }));
  } else {
    // Today, once the GPS form is in force.
    mgRows = [{ ...mgBlank(), date: todayWIB() >= mgRules().from ? todayWIB() : '' }];
  }
  if (!mgRows.length) mgRows = [mgBlank()];
  await mgWatchPermission();
  // The sites arrive after the form opens; the hints and map fill in then.
  loadCustomerSites().then(list => {
    mgSites = list;
    if (!$('#mgDays')) return;
    mgRows.forEach((r, i) => mgPaintSite(i));
    mgPaintMap();
  });
  const base = mgCfg().base;
  openModal(`
    ${formHeadHtml(isEdit ? t('Edit & resubmit GPS meal allowance') : t('Meal allowance (GPS)'))}
    <div class="modal-body">
      <form id="mgForm" class="form lf-form" novalidate>
        ${draft ? draftBannerHtml() : ''}
        <p class="form-error" id="mgError" hidden></p>
        <div class="meal-scroll">
          ${mgBaseHtml()}
          <p class="form-note caution mg-geo" id="mgGeoBanner" hidden></p>
          <section class="lf-sec">
            ${linesSectionHead(t('Days'), t('One card per day. Record your location where you eat — it is measured against your base — and attach the receipt.'))}
            <div id="mgDays" class="mg-days"></div>
            <button type="button" class="lf-add" id="mgAddDay">${esc(t('+ Add another day'))}</button>
            <div id="claimDateBox"></div>
          </section>
          ${approvalSectionHtml(approver1PickerHtml(existing) + (isEdit ? resubmitNoteHtml() : ''))}
        </div>
        <div class="modal-actions meal-foot">
          ${footTotalHtml('mgTotal')}
          <button type="button" class="btn btn-ghost" id="mgCancel">${esc(t('Cancel'))}</button>
          ${fresh ? `<button type="button" class="btn btn-ghost" id="mgSaveDraft">${esc(t('Save draft'))}</button>` : ''}
          <button type="submit" class="btn btn-primary" ${base ? '' : 'disabled'}>${isEdit ? esc(t('Resubmit claim')) : esc(t('Submit claim'))}</button>
        </div>
      </form>
    </div>`);
  $('#modal').classList.add('modal-wide', 'modal-flex');
  $('#modal .x-btn').addEventListener('click', closeModal);
  $('#mgCancel').addEventListener('click', fresh ? () => discardDraftAndClose(MG_KIND) : closeModal);
  $('#mgAddDay').addEventListener('click', () => {
    mgReadRows(); mgRows.push(mgBlank()); mgRender();
    const i = mgRows.length - 1;
    const card = $(`#mgDays .mg-day[data-i="${i}"]`); if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (mgGeo === 'granted') mgCapture(i, true);
  });
  $('#mgForm').addEventListener('submit', e => submitMealGps(e, existing));
  mgPaintGeoBanner();
  renderClaimDateBox();
  mgRender();
  mgInitMap();
  if (fresh) {
    if (draft && draft.data.approver1) { const sel = $('#mgForm [name="approver1"]'); if (sel) sel.value = draft.data.approver1; }
    $('#mgSaveDraft').addEventListener('click', () => saveDraftAndClose(MG_KIND, collectMealGpsDraft, collectMealGpsFiles));
    armDraftAutosave(MG_KIND, collectMealGpsDraft, collectMealGpsFiles);
    if (draft) wireDraftBanner(MG_KIND, () => openMealGpsModal());
    // "Allow GPS all the time": with access already granted, today's card
    // records where the claimant is straight away.
    if (!draft && mgGeo === 'granted') mgCapture(0, true);
  }
}

async function submitMealGps(e, existing) {
  e.preventDefault();
  mgReadRows();
  const err = $('#mgError'); err.hidden = true;
  const fail = (msg) => { err.textContent = msg; err.hidden = false; err.scrollIntoView({ block: 'nearest' }); };
  const rows = mgRows.filter(mgFilled);
  if (!rows.length) return fail(t('Add at least one day.'));
  const dates = new Set();
  for (const [k, r] of rows.entries()) {
    const chk = mgCheck(r);
    if (!r.date) return fail(t('Day {n}: choose the date.', { n: k + 1 }));
    if (dates.has(r.date)) return fail(t('Day {n}: {date} is already on this claim — one card per day.', { n: k + 1, date: r.date }));
    dates.add(r.date);
    if (chk.errs.length) { mgRender(); return fail(t('Day {n}: {msg}', { n: k + 1, msg: chk.errs[0] })); }
  }
  const dateErr = claimDatesError(rows.map(r => r.date));
  if (dateErr) return fail(dateErr);
  const needsApprover1 = (state.user.approver1_choices || []).length >= 2;
  const approver1 = String((new FormData(e.target).get('approver1') || '')).trim();
  if (needsApprover1 && !approver1) return fail(t('Please choose Approver 1.'));
  const btn = e.target.querySelector('button[type="submit"]');
  const label = btn.textContent;
  btn.disabled = true;
  try {
    if (rows.some(r => r.files.length)) btn.textContent = t('Uploading receipts…');
    const lines = [];
    for (const r of rows) {
      const uploaded = r.files.length ? await uploadReceipts(r.files) : [];
      lines.push({
        date: r.date, trip_type: r.trip, site: r.site, category: r.category, desc: r.desc, gps: r.gps,
        amount: r.trip === 'in_town' ? mealAmount(r.amount) : 0,
        meals: r.trip === 'out_of_town' ? r.meals.map(mealAmount).filter(n => n > 0) : [],
        attachments: uploaded, keep_attachment_ids: r.kept.map(a => a.id)
      });
    }
    const payload = { scheme: 'gps', lines };
    if (needsApprover1) payload.approver1 = Number(approver1);
    btn.textContent = existing ? t('Resubmitting…') : t('Submitting…');
    if (existing) {
      payload.resubmit_note = String(new FormData(e.target).get('resubmit_note') || '').trim();
      await api('/meal-claims/' + existing.id, { method: 'PUT', body: JSON.stringify(payload) });
      toast(t('Meal claim resubmitted'));
    } else {
      await api('/meal-claims', { method: 'POST', body: JSON.stringify(payload) });
      toast(t('Meal claim submitted'));
      clearDraft(MG_KIND);
    }
    modalCloseHook = null; // submitted — don't auto-save a draft on close
    closeModal(); closeDrawer(); loadAll();
  } catch (ex) { fail(ex.message); btn.disabled = false; btn.textContent = label; }
}

$('#newMealGpsBtn').addEventListener('click', () => {
  if (advanceHold()) return toast(advanceHoldReason(), true);
  openMealGpsModal();
});
