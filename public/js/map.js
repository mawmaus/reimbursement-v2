'use strict';

// Maps: Leaflet 1.9.4 (vendored, loaded on first use) over OpenStreetMap tiles —
// CSP img-src allows tile.openstreetmap.org (app.js + vercel.json). Used by
// Settings → Bases, the GPS meal allowance form and its claim drawer. Every
// ring is the GPS rule's straight-line radius around a base, never a route.

let _leafletPromise;
function loadLeaflet() {
  if (!_leafletPromise) _leafletPromise = new Promise((resolve, reject) => {
    if (window.L) return resolve(window.L);
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'vendor/leaflet.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = 'vendor/leaflet.js';
    s.onload = () => resolve(window.L);
    s.onerror = () => { _leafletPromise = null; reject(new Error('Could not load the map')); };
    document.head.appendChild(s);
  });
  return _leafletPromise;
}

// A themed map in `el` (a .map-box). Wheel zoom waits for a click, so scrolling
// the page never gets caught on the map. Null (with a note in `el`) when
// Leaflet can't load, or when `el` left the page while it loaded.
async function makeMap(el) {
  let L;
  try { L = await loadLeaflet(); }
  catch { el.innerHTML = `<p class="map-msg">${esc(t('The map couldn’t load. Check your connection and try again.'))}</p>`; return null; }
  if (!el.isConnected) return null;
  el.innerHTML = '';
  const map = L.map(el, { scrollWheelZoom: false, zoomSnap: 0.5 });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    // OSM's tile policy requires a Referer and blocks tiles without one ("Access
    // blocked"); the site's Referrer-Policy (same-origin) sends none cross-origin,
    // so tile images send just our origin — never the page path.
    referrerPolicy: 'strict-origin-when-cross-origin',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
  }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  map.on('click', () => map.scrollWheelZoom.enable());
  map.on('mouseout', () => map.scrollWheelZoom.disable());
  // A map drawn inside an opening modal / drawer can measure itself mid-animation.
  setTimeout(() => { if (el.isConnected) map.invalidateSize(); }, 350);
  return map;
}
const mapColor = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
// The area a ring of `km` around `ll` covers (circle.getBounds needs a map view; this doesn't).
const ringArea = (ll, km) => L.latLng(ll.lat, ll.lng).toBounds(km * 2000);
function fitAreas(map, areas) {
  if (!areas.length) return map.setView([5, 112], 4); // nothing to show: the whole of South-East Asia
  const all = areas.reduce((acc, a) => acc.extend(a), L.latLngBounds(areas[0].getSouthWest(), areas[0].getNorthEast()));
  map.fitBounds(all, { padding: [24, 24], maxZoom: 12 });
}

// A base as a labelled dot inside its radius ring. `faded` dims it (a base
// being moved). Returns { ring, dot, area }.
function mapBase(map, b, km, { faded = false, popup = '' } = {}) {
  const brand = mapColor('--pine', '#f7982a'), deep = mapColor('--pine-deep', '#ad5300');
  const ring = L.circle([b.lat, b.lng], { radius: km * 1000, color: brand, weight: 2, opacity: faded ? 0.35 : 0.9,
    fillColor: brand, fillOpacity: faded ? 0.04 : 0.12, interactive: false }).addTo(map);
  const dot = L.circleMarker([b.lat, b.lng], { radius: 6, color: '#fff', weight: 2, fillColor: deep, fillOpacity: 1 }).addTo(map);
  dot.bindTooltip(esc(b.name || t('Base')), { permanent: true, direction: 'top', offset: [0, -8], className: 'map-label' });
  if (popup) dot.bindPopup(popup);
  return { ring, dot, area: ringArea(b, km) };
}

// Numbered pins for recorded GPS points, each joined to its base by a dashed
// straight line (the distance the rule measures). Points: { lat, lng, n,
// base?, bad?, popup }. Drawn into `layer`, which is cleared first.
function mapPins(layer, points) {
  const deep = mapColor('--pine-deep', '#ad5300');
  layer.clearLayers();
  for (const p of points) {
    if (p.base) L.polyline([[p.base.lat, p.base.lng], [p.lat, p.lng]], { color: p.bad ? mapColor('--red', '#c0392b') : deep,
      weight: 1.5, opacity: 0.7, dashArray: '4 6', interactive: false }).addTo(layer);
    const pin = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: `map-pin${p.bad ? ' bad' : ''}`, html: `<span>${esc(String(p.n))}</span>`, iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12] }),
      title: String(p.n)
    }).addTo(layer);
    if (p.popup) pin.bindPopup(p.popup);
  }
}

// --- Customer sites ---------------------------------------------------------------------
// Pinned customer locations by DB number (Settings → Customer sites), read once
// per account and shared by the GPS form and the bases map. A failed read is
// an empty list: the sites only add hints, nothing depends on them.
let _sitesCache = null;
function loadCustomerSites() {
  const uid = state.user && state.user.id;
  if (!_sitesCache || _sitesCache.uid !== uid) {
    _sitesCache = { uid, list: api('/customer-sites').then(d => d.sites || []).catch(() => { _sitesCache = null; return []; }) };
  }
  return _sitesCache.list;
}
const forgetCustomerSites = () => { _sitesCache = null; };
// The site a DB field points at ("DB 500222" → the site pinned as 500222), or null.
const siteForDb = (sites, v) => {
  const d = String(v || '').replace(/\D/g, '');
  return d ? (sites || []).find(s => s.db_no === d) || null : null;
};
// Straight-line km between two points (the rule's radius, same formula as the server).
function kmBetween(a, b) {
  const rad = (d) => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const kmLabel = (km) => t('{km} km', { km: (Math.round(km * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 }) });
// Customer sites as small blue squares. `big` marks the ones a form points at.
// Points: { lat, lng, popup, big?, base? } — `base` draws the dashed line to it.
function mapSites(layer, points) {
  const blue = mapColor('--indigo', '#3e6a8a');
  layer.clearLayers();
  const drawn = [];
  for (const p of points) {
    if (p.base) L.polyline([[p.base.lat, p.base.lng], [p.lat, p.lng]], { color: blue, weight: 1.5, opacity: 0.7, dashArray: '4 6', interactive: false }).addTo(layer);
    const s = p.big ? 18 : 10;
    const m = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: `map-site${p.big ? ' big' : ''}`, html: p.big ? '<span>DB</span>' : '', iconSize: [s, s], iconAnchor: [s / 2, s / 2], popupAnchor: [0, -s / 2] }),
      keyboard: false
    }).addTo(layer);
    if (p.popup) m.bindPopup(p.popup);
    drawn.push(m);
  }
  return drawn;
}
// A site's popup: DB number, name, address and — given a base — how far it is.
function sitePopupHtml(s, base, km) {
  const dist = base ? `<br>${sitePopupDist(s, base, km)}` : '';
  return `<b>DB${esc(s.db_no)}</b>${s.name ? ' · ' + esc(s.name) : ''}${s.address ? `<br><span class="map-ll">${esc(s.address)}</span>` : ''}${dist}
    <br><a href="https://www.google.com/maps?q=${encodeURIComponent(s.lat + ',' + s.lng)}" target="_blank" rel="noopener">${esc(t('Open in Maps'))}</a>`;
}
function sitePopupDist(s, base, km) {
  const d = kmBetween(base, s);
  return `${withRadius(t('{km} {radius} from {base}', { km: kmLabel(d), base: base.name || t('base') }))} — ${esc(d < km
    ? t('inside {min} km: in-town meals can’t be claimed', { min: km })
    : t('{min} km or more: in-town meals can be claimed', { min: km }))}`;
}

// --- Bases map (home tile) ------------------------------------------------------------
// Everyone can see where the bases are: their region's bases (every region for
// an all-regions viewer) with their rings, their own base marked, and a list
// that flies the map to a base.
async function openBasesMap() {
  openModal(`
    <div class="modal-head"><div><h2>${esc(t('Bases map'))}</h2>
      <div class="lf-sub"><span id="bmSub"></span></div></div>
      <button type="button" class="x-btn" id="bmClose" aria-label="${esc(t('Close'))}">×</button></div>
    <div class="modal-body bm-body">
      <div class="bm-map map-box" id="bmMap"><p class="map-msg">${esc(t('Loading map…'))}</p></div>
      <p class="map-key" id="bmKey"></p>
      <div class="bm-find" id="bmFind" hidden>
        <input class="input" id="bmQ" type="search" autocomplete="off" placeholder="${esc(t('Find a customer site — DB number or name'))}" aria-label="${esc(t('Find a customer site'))}" />
      </div>
      <div class="bm-list" id="bmList"></div>
    </div>`);
  $('#modal').classList.add('modal-wide', 'modal-flex');
  $('#bmClose').addEventListener('click', closeModal);
  let data, sites;
  try { [data, sites] = await Promise.all([api('/bases'), loadCustomerSites()]); }
  catch (ex) { const m = $('#bmMap'); if (m) m.innerHTML = `<p class="map-msg">${esc(ex.message)}</p>`; return; }
  const el = $('#bmMap');
  if (!el) return;
  const km = data.min_km || 30;
  const bases = data.bases || [];
  const mine = state.user && state.user.meal_gps && state.user.meal_gps.base;
  const isMine = (b) => !!mine && Math.abs(b.lat - mine.lat) < 1e-6 && Math.abs(b.lng - mine.lng) < 1e-6;
  // A location typed onto the account (not one from the list) still gets drawn.
  const shown = bases.slice();
  if (mine && !bases.some(isMine)) shown.unshift({ id: 'mine', name: mine.name || t('Your base'), lat: mine.lat, lng: mine.lng, region: '' });
  shown.sort((a, b) => (isMine(b) - isMine(a)) || String(a.region).localeCompare(String(b.region)) || a.name.localeCompare(b.name));
  const regions = new Set(shown.map(b => b.region).filter(Boolean));
  $('#bmSub').textContent = shown.length === 1 ? t('1 base') : t('{n} bases', { n: shown.length });
  $('#bmKey').innerHTML = `<span class="map-key-ring" aria-hidden="true"></span>${esc(t('Each ring is the {km} km straight-line radius around a base — in-town meals inside it can’t be claimed.', { km }))}`
    + (sites.length ? ` <span class="map-key-site" aria-hidden="true"></span>${esc(t('Customer sites ({n})', { n: sites.length }))}` : '');
  const basesHtml = shown.length ? shown.map(b => `
    <button type="button" class="bm-row${isMine(b) ? ' mine' : ''}" data-b="${esc(String(b.id))}">
      <span class="bm-ic" aria-hidden="true">🏢</span>
      <span class="bm-main"><b>${esc(b.name)}</b><small>${esc([regions.size > 1 ? b.region : '', `${b.lat}, ${b.lng}`].filter(Boolean).join(' · '))}</small></span>
      ${isMine(b) ? `<span class="bm-tag">${esc(t('Your base'))}</span>` : ''}
    </button>`).join('')
    : `<p class="bs-empty">${esc(t('No bases have been set up yet.'))}</p>`;
  $('#bmList').innerHTML = basesHtml;
  const map = await makeMap(el);
  if (!map) return;
  const drawn = new Map();
  for (const b of shown) {
    drawn.set(String(b.id), mapBase(map, b, km, {
      popup: `<b>${esc(b.name)}</b>${isMine(b) ? ` · ${esc(t('Your base'))}` : ''}<br><span class="map-ll">${esc(`${b.lat}, ${b.lng}`)}</span><br><a href="https://www.google.com/maps?q=${encodeURIComponent(b.lat + ',' + b.lng)}" target="_blank" rel="noopener">${esc(t('Open in Maps'))}</a>`
    }));
  }
  fitAreas(map, [...drawn.values()].map(d => d.area));
  // Customer sites: every pin, measured from the viewer's own base when they have one.
  const pins = mapSites(L.layerGroup().addTo(map), sites.map(s => ({ lat: s.lat, lng: s.lng, popup: sitePopupHtml(s, mine, km) })));
  const wireBases = () => $$('#bmList [data-b]').forEach(btn => btn.addEventListener('click', () => {
    const d = drawn.get(btn.dataset.b);
    if (!d) return;
    $$('#bmList .bm-row').forEach(x => x.classList.toggle('on', x === btn));
    map.flyToBounds(d.area, { padding: [24, 24], duration: 0.6 });
    d.dot.openPopup();
  }));
  wireBases();
  if (!sites.length) return;
  // The search swaps the list for matching sites; clearing it brings the bases back.
  $('#bmFind').hidden = false;
  const q = $('#bmQ');
  q.addEventListener('input', () => {
    const s = q.value.trim().toLowerCase();
    if (!s) { $('#bmList').innerHTML = basesHtml; wireBases(); return; }
    const digits = s.replace(/^db\s*/, '');
    const hits = sites.map((x, i) => ({ x, i }))
      .filter(({ x }) => x.db_no.includes(digits) || x.name.toLowerCase().includes(s) || x.address.toLowerCase().includes(s)).slice(0, 40);
    $('#bmList').innerHTML = hits.length ? hits.map(({ x, i }) => {
      const d = mine ? kmBetween(mine, x) : null;
      return `<button type="button" class="bm-row" data-s="${i}">
        <span class="bm-ic" aria-hidden="true">📌</span>
        <span class="bm-main"><b>DB${esc(x.db_no)}${x.name ? ' · ' + esc(x.name) : ''}</b><small>${esc(x.address || `${x.lat}, ${x.lng}`)}</small></span>
        ${d == null ? '' : `<span class="bm-km ${d < km ? 'in' : 'out'}">${esc(kmLabel(d))}</span>`}
      </button>`;
    }).join('') : `<p class="bs-empty">${esc(t('No customer site matches “{q}”.', { q: q.value.trim() }))}</p>`;
    $$('#bmList [data-s]').forEach(btn => btn.addEventListener('click', () => {
      const x = sites[+btn.dataset.s];
      $$('#bmList .bm-row').forEach(r => r.classList.toggle('on', r === btn));
      map.flyTo([x.lat, x.lng], 14, { duration: 0.6 });
      pins[+btn.dataset.s].openPopup();
    }));
  });
}
