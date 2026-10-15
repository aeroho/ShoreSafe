// A small map engine with no dependencies: pan, zoom, markers, and tap-to-place.
// Draws standard 256px Web Mercator tiles, so any tile server works.

const TILE = 256;

export const TILE_SOURCES = {
  street: {
    label: 'Street',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  },
  satellite: {
    label: 'Satellite',
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
  },
};

// Keep the map around New Jersey so the world never wraps.
const LIMITS = { south: 38.5, north: 41.6, west: -76.2, east: -73.4 };

export function project(lat, lng, zoom) {
  const size = TILE * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
}

export function unproject(x, y, zoom) {
  const size = TILE * 2 ** zoom;
  const n = Math.PI - (2 * Math.PI * y) / size;
  return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng: (x / size) * 360 - 180 };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class TileMap {
  constructor(el, { center, zoom, minZoom = 7, maxZoom = 18, onTap } = {}) {
    this.el = el;
    this.center = center;
    this.zoom = zoom;
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.onTap = onTap || (() => {});
    this.sourceName = 'street';
    this.tiles = new Map();
    this.groups = new Map();
    this.pointers = new Map();
    this.drag = null;
    this.pinchStart = 0;
    this.lastWheel = 0;
    this.raf = 0;

    el.classList.add('tilemap');
    el.tabIndex = 0;
    el.setAttribute('role', 'application');
    el.setAttribute('aria-label', 'Map. Use arrow keys to move and plus or minus to zoom. Use the list below for a text version.');
    this.tileLayer = document.createElement('div');
    this.tileLayer.className = 'tilemap-tiles';
    this.markerLayer = document.createElement('div');
    this.markerLayer.className = 'tilemap-markers';
    this.attribution = document.createElement('div');
    this.attribution.className = 'tilemap-attribution';
    this.controls = document.createElement('div');
    this.controls.className = 'tilemap-controls map-ctl';
    this.controls.innerHTML =
      '<button type="button" data-zoom="1" aria-label="Zoom in">+</button><button type="button" data-zoom="-1" aria-label="Zoom out">−</button>';
    el.append(this.tileLayer, this.markerLayer, this.controls, this.attribution);

    this.controls.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-zoom]');
      if (b) this.zoomAt(Number(b.dataset.zoom));
    });
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    el.addEventListener('dblclick', (e) => { if (!e.target.closest('.pin, .map-ctl')) this.zoomAt(1, e.clientX, e.clientY); });
    el.addEventListener('keydown', (e) => this.key(e));

    this.observer = new ResizeObserver(() => this.render());
    this.observer.observe(el);
    this.setSource('street');
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
  }

  // ----- public API -----

  setSource(name) {
    this.sourceName = name;
    this.source = TILE_SOURCES[name];
    this.maxZoom = Math.min(this.maxZoom, this.source.maxZoom);
    this.attribution.textContent = this.source.attribution;
    this.tileLayer.replaceChildren();
    this.tiles.clear();
    this.render();
  }

  setView(lat, lng, zoom = this.zoom) {
    this.zoom = clamp(Math.round(zoom), this.minZoom, this.maxZoom);
    this.center = this.limit({ lat, lng });
    this.render();
  }

  zoomAt(delta, clientX, clientY) {
    const next = clamp(this.zoom + delta, this.minZoom, this.maxZoom);
    if (next === this.zoom) return;
    const rect = this.el.getBoundingClientRect();
    const sx = clientX === undefined ? rect.width / 2 : clientX - rect.left;
    const sy = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    // Keep the spot under the cursor in place while zooming.
    const before = this.screenToLatLng(sx, sy);
    this.zoom = next;
    const pt = project(before.lat, before.lng, next);
    const c = unproject(pt.x - (sx - rect.width / 2), pt.y - (sy - rect.height / 2), next);
    this.center = this.limit(c);
    this.render();
  }

  /** Replace the markers in a named group. Each: { lat, lng, className, text, label, onClick }. */
  setMarkers(group, list) {
    (this.groups.get(group) || []).forEach((m) => m.el.remove());
    const made = list.map((m) => {
      const b = document.createElement(m.onClick ? 'button' : 'div');
      if (m.onClick) { b.type = 'button'; b.addEventListener('click', (e) => { e.stopPropagation(); m.onClick(); }); }
      b.className = `pin ${m.className || ''}`;
      b.textContent = m.text || '';
      if (m.data) Object.assign(b.dataset, m.data);
      if (m.label) { b.setAttribute('aria-label', m.label); b.title = m.label; }
      this.markerLayer.appendChild(b);
      return { el: b, lat: m.lat, lng: m.lng };
    });
    this.groups.set(group, made);
    this.positionMarkers();
  }

  // ----- geometry -----

  limit({ lat, lng }) {
    return { lat: clamp(lat, LIMITS.south, LIMITS.north), lng: clamp(lng, LIMITS.west, LIMITS.east) };
  }

  topLeft() {
    const c = project(this.center.lat, this.center.lng, this.zoom);
    return { x: Math.round(c.x - this.el.clientWidth / 2), y: Math.round(c.y - this.el.clientHeight / 2) };
  }

  screenToLatLng(sx, sy) {
    const tl = this.topLeft();
    return unproject(tl.x + sx, tl.y + sy, this.zoom);
  }

  // ----- drawing -----

  render() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.draw());
  }

  draw() {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return;
    const tl = this.topLeft();
    const n = 2 ** this.zoom;
    const needed = new Set();
    for (let x = Math.floor(tl.x / TILE); x <= Math.floor((tl.x + w) / TILE); x += 1) {
      for (let y = Math.floor(tl.y / TILE); y <= Math.floor((tl.y + h) / TILE); y += 1) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const key = `${this.sourceName}/${this.zoom}/${x}/${y}`;
        needed.add(key);
        let img = this.tiles.get(key);
        if (!img) {
          img = this.makeTile(this.source.url(this.zoom, x, y));
          this.tiles.set(key, img);
          this.tileLayer.appendChild(img);
        }
        img.style.transform = `translate(${x * TILE - tl.x}px, ${y * TILE - tl.y}px)`;
      }
    }
    for (const [key, img] of this.tiles) {
      if (!needed.has(key)) { img.remove(); this.tiles.delete(key); }
    }
    this.positionMarkers(tl);
  }

  makeTile(url) {
    const img = new Image(TILE, TILE);
    img.className = 'tile';
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.crossOrigin = 'anonymous'; // lets the offline cache store real, size-counted copies
    img.onerror = () => {
      if (!img.dataset.retried) { // some tile servers don't allow CORS: try the plain way once
        img.dataset.retried = '1';
        img.removeAttribute('crossorigin');
        img.src = url;
      } else {
        img.classList.add('tile-missing');
      }
    };
    img.src = url;
    return img;
  }

  positionMarkers(tl = this.topLeft()) {
    for (const list of this.groups.values()) {
      for (const m of list) {
        const p = project(m.lat, m.lng, this.zoom);
        m.el.style.transform = `translate(${Math.round(p.x - tl.x)}px, ${Math.round(p.y - tl.y)}px) translate(-50%, -50%)`;
      }
    }
  }

  // ----- input -----

  down(e) {
    if (e.target.closest('.pin, .map-ctl')) return;
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      const c = project(this.center.lat, this.center.lng, this.zoom);
      this.drag = { x: e.clientX, y: e.clientY, cx: c.x, cy: c.y, t: Date.now(), moved: false };
    } else if (this.pointers.size === 2) {
      this.pinchStart = this.pinchDistance();
      this.drag = null;
    }
  }

  move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2 && this.pinchStart) {
      const ratio = this.pinchDistance() / this.pinchStart;
      const [a, b] = [...this.pointers.values()];
      if (ratio > 1.6) { this.zoomAt(1, (a.x + b.x) / 2, (a.y + b.y) / 2); this.pinchStart = this.pinchDistance(); }
      else if (ratio < 0.62) { this.zoomAt(-1, (a.x + b.x) / 2, (a.y + b.y) / 2); this.pinchStart = this.pinchDistance(); }
      return;
    }
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    if (!this.drag.moved && Math.hypot(dx, dy) < 6) return;
    this.drag.moved = true;
    this.el.classList.add('dragging');
    this.center = this.limit(unproject(this.drag.cx - dx, this.drag.cy - dy, this.zoom));
    this.render();
  }

  up(e, cancelled = false) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    this.el.classList.remove('dragging');
    if (this.pointers.size < 2) this.pinchStart = 0;
    const d = this.drag;
    if (d && this.pointers.size === 0) {
      this.drag = null;
      if (!cancelled && !d.moved && Date.now() - d.t < 600) {
        const rect = this.el.getBoundingClientRect();
        const ll = this.screenToLatLng(e.clientX - rect.left, e.clientY - rect.top);
        this.onTap(ll.lat, ll.lng);
      }
    }
  }

  pinchDistance() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  wheel(e) {
    e.preventDefault();
    const now = Date.now();
    if (now - this.lastWheel < 180) return;
    this.lastWheel = now;
    this.zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY);
  }

  key(e) {
    const step = 80;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      const c = project(this.center.lat, this.center.lng, this.zoom);
      this.center = this.limit(unproject(c.x + moves[e.key][0], c.y + moves[e.key][1], this.zoom));
      this.render();
    } else if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomAt(1); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); this.zoomAt(-1); }
  }
}
