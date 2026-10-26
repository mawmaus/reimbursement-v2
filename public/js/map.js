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
