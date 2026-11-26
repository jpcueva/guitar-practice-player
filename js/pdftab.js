// Follow-along view for PDF tabs (Songsterr-style exports turned into a bundle by
// tools/pdf_tab_bundle.py). Shows the original pages and moves a cursor through
// each bar in time with the recording. Same interface as TabView.

export class PdfTabView extends EventTarget {
  constructor(host, scroller) {
    super();
    this.host = host;
    this.scroller = scroller;
    this.bundle = null;
    this.trackIndex = 0;
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
    if (trackIndex == null || !parts[trackIndex]) {
      // default: the part with the fewest bars inside multi-bar rests
      let best = 0, bestRest = Infinity;
      parts.forEach((p, i) => {
        const rest = p.bars.filter(b => !b || b.rest).length + (refBars(bundle) - p.bars.length);
        if (rest < bestRest) { bestRest = rest; best = i; }
      });
      trackIndex = best;
    }
    this.trackIndex = trackIndex;
    this.host.addEventListener('click', this._onClick);
    await this._render();
    return {
      tracks: parts.map((p, i) => ({ index: i, name: p.name, isGuitar: true })),
      trackIndex,
      barDefs: pdfBarDefs(bundle),
    };
  }

  async _render() {
    this.rendered = false;
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
    this.host.innerHTML = '';
    this.host.classList.remove('horizontal');
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
      const blob = await this.getBlob(pg.file);
      const url = URL.createObjectURL(blob);
      this.urls.push(url);
      img.src = url;
      loads.push(img.decode ? img.decode().catch(() => {}) : Promise.resolve());
      wrap.appendChild(img);
      this.pageEls.push(img);
    }
    for (const o of [this.loopHl, this.barHl, this.cursor]) { o.style.display = 'none'; this.host.appendChild(o); }
    await Promise.all(loads);
    this.rendered = true;
    this.dispatchEvent(new Event('rendered'));
  }

  setTrack(i) {
    if (!this.bundle?.parts[i]) return;
    this.trackIndex = i;
    this._lastScrollKey = null;
    this._render();
  }

  setLayout(layout, scale) {
    if (scale) this.scale = scale;
    if (this.wrap) {
      this._applyWidth(this.wrap);
      this._lastScrollKey = null;
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
    this.pageEls = [];
    this.bundle = null;
    this.rendered = false;
  }

  /** Box of bar `mi` (0-based) in host pixels, or null. */
  _box(mi) {
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
    if (follow) this._follow(bx);
  }

  showLoop(a, b) {
    if (!this.rendered || a == null) { this.loopHl.style.display = 'none'; return; }
    const A = this._box(a), B = this._box(b);
    if (!A || !B) { this.loopHl.style.display = 'none'; return; }
    const sameLine = Math.abs(A.y - B.y) < 2;
    const x1 = sameLine ? B.x + B.w : A.x + A.w;
    Object.assign(this.loopHl.style, { display: 'block', left: `${A.x}px`, width: `${x1 - A.x}px`, top: `${A.y}px`, height: `${A.h}px` });
  }

  _follow(bx) {
    const sc = this.scroller;
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
    for (let i = 0; i < part.bars.length; i++) {
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
