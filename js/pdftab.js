// Follow-along view for PDF tabs (Songsterr-style exports turned into a bundle by
// tools/pdf_tab_bundle.py). Same interface as TabView.
// Page layout shows the original pages of one part. One-line layout cuts every
// bar out of the pages and lines the bars up in a strip per part, with the
// chosen parts stacked so the same bar sits in the same column.

export class PdfTabView extends EventTarget {
  constructor(host, scroller) {
    super();
    this.host = host;
    this.scroller = scroller;
    this.bundle = null;
    this.trackIndex = 0;
    this.trackIndexes = [0];
    this.labels = [];
    this.layout = 'page';
    this.scale = 1;
    this.rendered = false;
    this.urls = [];
    this.pageEls = [];
    this.cursor = el('div', 'tab-cursor');
    this.barHl = el('div', 'tab-barhl');
    this.loopHl = el('div', 'tab-loophl');
    this._lastScrollKey = null;
    this._onClick = this._onClick.bind(this);
  }

  /**
   * @param {object} bundle   parsed tab.json
   * @param {(path:string)=>Promise<Blob>} getBlob
   */
  async load(bundle, trackIndex, getBlob) {
    this.destroy();
    this.bundle = bundle;
    this.getBlob = getBlob;
    const parts = bundle.parts;
    let list = (Array.isArray(trackIndex) ? trackIndex : trackIndex == null ? [] : [trackIndex]).filter(i => parts[i]);
    trackIndex = list[0];
    if (trackIndex == null) {
      // default: the part with the fewest bars inside multi-bar rests
      let best = 0, bestRest = Infinity;
      parts.forEach((p, i) => {
        const rest = p.bars.filter(b => !b || b.rest).length + (refBars(bundle) - p.bars.length);
        if (rest < bestRest) { bestRest = rest; best = i; }
      });
      trackIndex = best;
    }
    this.trackIndex = trackIndex;
    this.trackIndexes = list.length ? list : [trackIndex];
    this.host.addEventListener('click', this._onClick);
    await this._render();
    return {
      tracks: parts.map((p, i) => ({ index: i, name: p.name, isGuitar: true, strings: 6 })),
      trackIndex,
      trackIndexes: this.trackIndexes.slice(),
      barDefs: pdfBarDefs(bundle),
    };
  }

  async _url(file) {
    this._urlCache ||= new Map();
    if (!this._urlCache.has(file)) {
      const url = URL.createObjectURL(await this.getBlob(file));
      this.urls.push(url);
      this._urlCache.set(file, url);
    }
    return this._urlCache.get(file);
  }

  async _render() {
    this.rendered = false;
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
    this._urlCache = new Map();
    this.host.innerHTML = '';
    this.labels = [];
    this.host.classList.remove('horizontal');
    this.strip = null;
    if (this.layout === 'horizontal') return this._renderStrip();
    const wrap = el('div', 'pdf-pages');
    this._applyWidth(wrap);
    this.host.appendChild(wrap);
    this.wrap = wrap;
    const part = this.bundle.parts[this.trackIndex];
    this.pageEls = [];
    const loads = [];
    for (const pg of part.pages) {
      const img = new Image();
      img.className = 'pdf-page';
      img.alt = '';
      img.width = pg.w; img.height = pg.h; // reserves space before the image loads
      img.src = await this._url(pg.file);
      loads.push(img.decode ? img.decode().catch(() => {}) : Promise.resolve());
      wrap.appendChild(img);
      this.pageEls.push(img);
    }
    for (const o of [this.loopHl, this.barHl, this.cursor]) { o.style.display = 'none'; this.host.appendChild(o); }
    await Promise.all(loads);
    this.rendered = true;
    this.dispatchEvent(new Event('rendered'));
  }

  /**
   * One-line layout: one row per shown part. Each bar is a slice of its page
   * image (CSS background), scaled to the row height. Every column is as wide
   * as the widest part's bar, so bar n lines up in all rows.
   */
  async _renderStrip() {
    const parts = this.trackIndexes.map(i => this.bundle.parts[i]).filter(Boolean);
    const H = Math.round(96 * this.scale);       // drawn staff height per row
    const gap = Math.round(H * 0.32);            // room for the part name above each row
    const n = refBars(this.bundle);
    // natural width of bar i in part p at height H
    const natW = (p, i) => {
      const b = p.bars[i];
      if (!b) return 0;
      const pg = p.pages[b.page];
      return ((b.x1 - b.x0) * pg.w) * H / Math.max(1, (b.y1 - b.y0) * pg.h);
    };
    const cols = [];
    let x = 8;
    for (let i = 0; i < n; i++) {
      const w = Math.max(40, ...parts.map(p => natW(p, i)));
      cols.push({ x, w });
      x += w;
    }
    const wrap = el('div', 'pdf-strip');
    wrap.style.width = `${x + 8}px`;
    wrap.style.height = `${parts.length * (H + gap) + 8}px`;
    for (let r = 0; r < parts.length; r++) {
      const p = parts[r];
      const top = r * (H + gap) + gap;
      const urls = await Promise.all(p.pages.map(pg => this._url(pg.file)));
      for (let i = 0; i < n; i++) {
        const b = p.bars[i];
        if (!b) continue;
        const pg = p.pages[b.page];
        const k = H / ((b.y1 - b.y0) * pg.h);      // page px -> strip px
        if (b.rest) {
          // A slice of a multi-bar rest box reads as noise; show a plain rest instead.
          const rest = el('div', 'pdf-rest');
          rest.textContent = 'rest';
          Object.assign(rest.style, { left: `${cols[i].x}px`, top: `${top}px`, width: `${cols[i].w}px`, height: `${H}px` });
          wrap.appendChild(rest);
          continue;
        }
        const cell = el('div', 'pdf-bar');
        Object.assign(cell.style, {
          left: `${cols[i].x}px`, top: `${top}px`, width: `${natW(p, i)}px`, height: `${H}px`,
          backgroundImage: `url("${urls[b.page]}")`,
          backgroundSize: `${pg.w * k}px ${pg.h * k}px`,
          backgroundPosition: `${-b.x0 * pg.w * k}px ${-b.y0 * pg.h * k}px`,
        });
        wrap.appendChild(cell);
      }
      const lab = el('div', 'tab-part-label');
      lab.textContent = p.name;
      lab.style.top = `${top - gap + 4}px`;
      this.labels.push(lab);
    }
    this.host.classList.add('horizontal');
    this.host.appendChild(wrap);
    for (const l of this.labels) this.host.appendChild(l);
    this.strip = { cols, top: gap, height: parts.length * (H + gap) - gap, wrap };
    for (const o of [this.loopHl, this.barHl, this.cursor]) { o.style.display = 'none'; this.host.appendChild(o); }
    this._placeLabels();
    if (!this._labelScroll) {
      this._labelScroll = () => this._placeLabels();
      this.scroller.addEventListener('scroll', this._labelScroll, { passive: true });
    }
    this.rendered = true;
    this.dispatchEvent(new Event('rendered'));
  }

  _placeLabels() {
    if (!this.labels.length) return;
    const left = Math.max(0, this.scroller.scrollLeft - this.host.offsetLeft) + 6;
    for (const l of this.labels) l.style.left = `${left}px`;
  }

  setTrack(i) {
    this.setTracks([i]);
  }

  setTracks(list) {
    list = (list || []).filter(i => this.bundle?.parts[i]);
    if (!list.length) return;
    this.trackIndexes = list;
    this.trackIndex = list[0];
    this._lastScrollKey = null;
    this._render();
  }

  setLayout(layout, scale) {
    const relayout = (layout && layout !== this.layout) || (scale && scale !== this.scale && this.layout === 'horizontal');
    if (layout) this.layout = layout;
    if (scale) this.scale = scale;
    this._lastScrollKey = null;
    if (relayout && this.bundle) return this._render();
    if (this.wrap && this.layout !== 'horizontal') {
      this._applyWidth(this.wrap);
      this.dispatchEvent(new Event('rendered'));
    }
  }

  _applyWidth(wrap) {
    // Phones default to 90% for the drawn tab; PDF pages read better full width.
    const s = this.scale + (window.innerWidth < 500 ? 0.1 : 0);
    wrap.style.width = `${Math.round(s * 100)}%`;
    wrap.style.maxWidth = `${Math.round(1100 * s)}px`;
  }

  destroy() {
    this.host.removeEventListener('click', this._onClick);
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
    this._urlCache = new Map();
    this.pageEls = [];
    this.labels = [];
    this.strip = null;
    this.bundle = null;
    this.rendered = false;
  }

  /** Box of bar `mi` (0-based) in host pixels, or null. */
  _box(mi) {
    if (this.strip) {
      const c = this.strip.cols[mi];
      if (!c) return null;
      const s = this.strip.wrap;
      return { x: s.offsetLeft + c.x, w: c.w, y: s.offsetTop + this.strip.top, h: this.strip.height, rest: false };
    }
    const b = this.bundle?.parts[this.trackIndex]?.bars[mi];
    if (!b) return null;
    const img = this.pageEls[b.page];
    if (!img) return null;
    const h = this.host.getBoundingClientRect(), r = img.getBoundingClientRect();
    const ox = r.left - h.left, oy = r.top - h.top;
    return {
      x: ox + b.x0 * r.width, w: (b.x1 - b.x0) * r.width,
      y: oy + b.y0 * r.height, h: (b.y1 - b.y0) * r.height, rest: !!b.rest,
    };
  }

  update(mi, frac, { follow = true } = {}) {
    if (!this.rendered) return;
    const bx = this._box(mi);
    if (!bx) { this.cursor.style.display = 'none'; this.barHl.style.display = 'none'; return; }
    // Notes start a little after the barline; keep the cursor inside the bar's note area.
    const pad = Math.min(bx.w * 0.06, 18);
    const x = bx.x + pad + frac * (bx.w - pad * 1.5);
    Object.assign(this.cursor.style, { display: 'block', left: `${x}px`, top: `${bx.y}px`, height: `${bx.h}px` });
    Object.assign(this.barHl.style, { display: 'block', left: `${bx.x}px`, top: `${bx.y}px`, width: `${bx.w}px`, height: `${bx.h}px` });
    if (follow) this._follow(bx, x);
  }

  showLoop(a, b) {
    if (!this.rendered || a == null) { this.loopHl.style.display = 'none'; return; }
    const A = this._box(a), B = this._box(b);
    if (!A || !B) { this.loopHl.style.display = 'none'; return; }
    const sameLine = Math.abs(A.y - B.y) < 2;
    const x1 = sameLine ? B.x + B.w : A.x + A.w;
    Object.assign(this.loopHl.style, { display: 'block', left: `${A.x}px`, width: `${x1 - A.x}px`, top: `${A.y}px`, height: `${A.h}px` });
  }

  _follow(bx, x) {
    const sc = this.scroller;
    if (this.strip) {
      // keep the cursor about a third of the way in, like the drawn tab's one-line view
      const target = Math.max(0, this.host.offsetLeft + x - sc.clientWidth * 0.3);
      if (Math.abs(sc.scrollLeft - target) > sc.clientWidth * 0.6) sc.scrollLeft = target;
      else sc.scrollLeft += (target - sc.scrollLeft) * 0.15;
      if (this._lastScrollKey !== 'strip') { this._lastScrollKey = 'strip'; sc.scrollTo({ top: 0 }); }
      return;
    }
    if (sc.scrollWidth > sc.clientWidth + 4) {
      const cx = this.host.offsetLeft + bx.x;
      if (cx < sc.scrollLeft || cx + bx.w > sc.scrollLeft + sc.clientWidth) sc.scrollTo({ left: Math.max(0, cx - 12), behavior: 'smooth' });
    }
    const key = Math.round(bx.y);
    if (key === this._lastScrollKey) return;
    this._lastScrollKey = key;
    const target = this.host.offsetTop + bx.y - Math.min(60, sc.clientHeight * 0.12);
    sc.scrollTo({ top: target, behavior: 'smooth' });
  }

  _onClick(e) {
    const part = this.bundle?.parts[this.trackIndex];
    if (!part) return;
    const h = this.host.getBoundingClientRect();
    const x = e.clientX - h.left, y = e.clientY - h.top;
    const count = this.strip ? this.strip.cols.length : part.bars.length;
    for (let i = 0; i < count; i++) {
      const bx = this._box(i);
      if (bx && x >= bx.x && x < bx.x + bx.w && y >= bx.y && y < bx.y + bx.h) {
        const frac = Math.max(0, Math.min(0.999, (x - bx.x) / bx.w));
        this.dispatchEvent(new CustomEvent('barclick', { detail: { masterIndex: i, frac: bx.rest ? 0 : frac } }));
        return;
      }
    }
  }
}

function el(tag, cls) {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function refBars(bundle) {
  return Math.max(...bundle.parts.map(p => p.bars.length));
}

/** Bars for the timeline: 4/4, tempo and sections from the most complete part. */
export function pdfBarDefs(bundle) {
  const ref = bundle.parts.reduce((a, p) => (p.bars.filter(b => b && !b.rest).length > a.bars.filter(b => b && !b.rest).length ? p : a), bundle.parts[0]);
  const n = refBars(bundle);
  const defs = [];
  let tempo = 120;
  for (let i = 1; i <= n; i++) {
    if (ref.tempos?.[i]) tempo = ref.tempos[i];
    defs.push({ masterIndex: i - 1, number: i, beats: 4, quarters: 4, tempo, section: ref.sections?.[i] || null });
  }
  return defs;
}
