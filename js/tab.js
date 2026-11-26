// Guitar tab rendering (alphaTab) with a cursor driven by our own audio clock.
// alphaTab's built-in synth player is not used; the recording is the timing source.

import { beatsForSignature } from './timeline.js';

export class TabView extends EventTarget {
  constructor(host, scroller) {
    super();
    this.host = host;
    this.scroller = scroller;
    this.api = null;
    this.score = null;
    this.trackIndex = 0;      // the part the cursor follows (the top one)
    this.trackIndexes = [0];  // parts shown, top to bottom
    this.labels = [];
    this.layout = 'page';
    this.scale = 1;
    this.rendered = false;
    this._lastBar = -1;
    this._lastScrollKey = null;
    this.cursor = document.createElement('div');
    this.cursor.className = 'tab-cursor';
    this.barHl = document.createElement('div');
    this.barHl.className = 'tab-barhl';
    this.loopHl = document.createElement('div');
    this.loopHl.className = 'tab-loophl';
    this.host.addEventListener('click', (e) => this._onClick(e));
  }

  _settings() {
    return {
      core: { fontDirectory: new URL('vendor/alphatab/font/', document.baseURI).href, useWorkers: false, enableLazyLoading: false },
      display: {
        staveProfile: 'Tab',
        layoutMode: this.layout === 'horizontal' ? 'Horizontal' : 'Page',
        scale: this.scale,
        resources: {
          mainGlyphColor: '#e2e8f0', secondaryGlyphColor: '#94a3b8', staffLineColor: '#475569',
          barSeparatorColor: '#64748b', barNumberColor: '#f59e0b', scoreInfoColor: '#cbd5e1',
        },
      },
      notation: { rhythmMode: 'ShowWithBars' },
      player: { enablePlayer: false },
    };
  }

  /**
   * Load a tab file. Resolves with {tracks, barDefs} once the score is parsed.
   * trackIndex: one part, or an array of parts to stack (top to bottom), or null for a default.
   */
  load(data, trackIndex = null) {
    let wanted = Array.isArray(trackIndex) ? trackIndex.slice() : trackIndex == null ? null : [trackIndex];
    this.destroy();
    this.rendered = false;
    this.host.innerHTML = '';
    const surfaceHost = document.createElement('div');
    surfaceHost.className = 'tab-surface-host';
    this.host.appendChild(surfaceHost);
    this.surfaceHost = surfaceHost;
    // Overlays live next to alphaTab's surface (alphaTab clears its own surface when it re-renders).
    for (const el of [this.loopHl, this.barHl, this.cursor]) { el.style.display = 'none'; this.host.appendChild(el); }
    this.api = new window.alphaTab.AlphaTabApi(surfaceHost, this._settings());
    return new Promise((resolve, reject) => {
      this.api.error.on((e) => reject(e?.error || e));
      this.api.scoreLoaded.on((score) => {
        this.score = score;
        const tracks = score.tracks.map((t, i) => ({
          index: i, name: t.name || `Track ${i + 1}`,
          strings: t.staves[0]?.isPercussion ? 0 : t.staves[0]?.tuning?.length || 0, // 0 = drums, not shown as tab
          isGuitar: (t.staves[0]?.tuning?.length || 0) >= 6 && !t.staves[0]?.isPercussion && (t.staves[0]?.tuning?.[0] || 0) > 0,
        }));
        wanted = (wanted || []).filter(i => score.tracks[i] && tracks[i].strings > 0);
        if (wanted.length) trackIndex = wanted[0];
        else {
          // default to the guitar part with the most notes (the main riff, not an intro-only part)
          const notes = (t) => { let n = 0; for (const b of t.staves[0]?.bars || []) for (const bt of b.voices[0]?.beats || []) if (!bt.isRest) n++; return n; };
          const guitars = tracks.filter(t => t.isGuitar);
          const g = guitars.sort((a, b) => notes(score.tracks[b.index]) - notes(score.tracks[a.index]))[0] || tracks[0];
          trackIndex = g ? g.index : 0;
        }
        this.trackIndex = trackIndex;
        this.trackIndexes = wanted.length ? wanted : [trackIndex];
        if (this.trackIndexes.length > 1) {
          // api.load() renders the first part; switch to the stack once it is parsed.
          queueMicrotask(() => this.api?.renderTracks(this.trackIndexes.map(i => score.tracks[i])));
        }
        resolve({ tracks, trackIndex, trackIndexes: this.trackIndexes.slice(), barDefs: this.barDefs(), title: score.title, artist: score.artist });
      });
      this.api.renderFinished.on(() => {
        this.rendered = true;
        this._attachOverlay();
        this._renderLabels();
        this._lastBar = -1;
        this.dispatchEvent(new Event('rendered'));
      });
      try {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        this.api.load(bytes, [wanted?.[0] ?? 0]);
      } catch (e) { reject(e); }
    });
  }

  setTrack(i) {
    this.setTracks([i]);
  }

  /** Show several parts stacked, top to bottom, in this order. */
  setTracks(list) {
    list = (list || []).filter(i => this.score?.tracks[i]);
    if (!this.api || !list.length) return;
    this.trackIndexes = list;
    this.trackIndex = list[0];
    this.rendered = false;
    this.api.renderTracks(list.map(i => this.score.tracks[i]));
  }

  /** Part names pinned to the left edge, so you can tell the stacked lines apart. */
  _renderLabels() {
    for (const l of this.labels) l.remove();
    this.labels = [];
    if (this.trackIndexes.length < 2) return;
    const lk = this._lookup();
    const sys = lk?.staffSystems?.[0];
    const staffBars = sys?.bars?.[0]?.bars || [];
    const o = this._off();
    // one BarBounds per staff, in the order the parts are drawn
    staffBars.forEach((bb, k) => {
      const t = this.score.tracks[this.trackIndexes[k]];
      if (!t) return;
      const el = document.createElement('div');
      el.className = 'tab-part-label';
      el.textContent = t.name || `Part ${k + 1}`;
      el.style.top = `${o.y + bb.visualBounds.y - 2}px`;
      this.host.appendChild(el);
      this.labels.push(el);
    });
    this._placeLabels();
    if (!this._labelScroll) {
      this._labelScroll = () => this._placeLabels();
      this.scroller.addEventListener('scroll', this._labelScroll, { passive: true });
    }
  }

  _placeLabels() {
    if (!this.labels.length) return;
    const left = Math.max(0, this.scroller.scrollLeft - this.host.offsetLeft) + 6;
    for (const el of this.labels) el.style.left = `${left}px`;
  }

  setLayout(layout, scale) {
    if (layout) this.layout = layout;
    if (scale) this.scale = scale;
    if (!this.api) return;
    const s = this.api.settings;
    s.display.layoutMode = this.layout === 'horizontal' ? window.alphaTab.LayoutMode.Horizontal : window.alphaTab.LayoutMode.Page;
    s.display.scale = this.scale;
    this.api.updateSettings();
    this.rendered = false;
    this.api.render();
    this.host.classList.toggle('horizontal', this.layout === 'horizontal');
  }

  destroy() {
    for (const l of this.labels) l.remove();
    this.labels = [];
    if (this.api) { try { this.api.destroy(); } catch {} }
    this.api = null;
    this.score = null;
  }

  /** Bars in playback order (repeats and alternate endings expanded). */
  barDefs() {
    return scoreBarDefs(this.score);
  }

  _attachOverlay() {
    this.surface = this.surfaceHost.querySelector('.at-surface') || this.surfaceHost;
  }

  /** Offset of alphaTab's surface inside the host, where the overlays are positioned. */
  _off() {
    const s = this.surfaceHost.querySelector('.at-surface') || this.surfaceHost;
    this.surface = s;
    const h = this.host.getBoundingClientRect(), r = s.getBoundingClientRect();
    return { x: r.left - h.left, y: r.top - h.top };
  }

  _lookup() {
    return this.api?.boundsLookup || this.api?.renderer?.boundsLookup || null;
  }

  /** Move the cursor to master bar `mi` at fraction `frac` (0..1, beat-linear). */
  update(mi, frac, { follow = true } = {}) {
    if (!this.rendered) return;
    const lk = this._lookup();
    const mbb = lk?.findMasterBarByIndex(mi);
    if (!mbb) { this.cursor.style.display = 'none'; this.barHl.style.display = 'none'; return; }
    const r = mbb.realBounds;
    const v = mbb.visualBounds;
    // Place the cursor on the beat whose start tick has passed, interpolating to the next beat.
    let x = r.x + frac * r.w;
    const bar = this.score.tracks[this.trackIndex]?.staves[0]?.bars[mi];
    const ticks = this.score.masterBars[mi].calculateDuration?.() || 3840;
    const beats = bar?.voices[0]?.beats || [];
    if (beats.length) {
      const tick = frac * ticks;
      let k = 0;
      while (k + 1 < beats.length && beats[k + 1].playbackStart <= tick) k++;
      const b0 = lk.findBeat(beats[k]);
      const b1 = k + 1 < beats.length ? lk.findBeat(beats[k + 1]) : null;
      if (b0) {
        const x0 = b0.onNotesX ?? (b0.visualBounds.x + b0.visualBounds.w / 2);
        const x1 = b1 ? (b1.onNotesX ?? (b1.visualBounds.x + b1.visualBounds.w / 2)) : r.x + r.w;
        const t0 = beats[k].playbackStart;
        const t1 = k + 1 < beats.length ? beats[k + 1].playbackStart : ticks;
        const f = t1 > t0 ? Math.min(1, Math.max(0, (tick - t0) / (t1 - t0))) : 0;
        x = x0 + f * (x1 - x0);
      }
    }
    const o = this._off();
    Object.assign(this.cursor.style, { display: 'block', left: `${o.x + x}px`, top: `${o.y + v.y}px`, height: `${v.h}px` });
    Object.assign(this.barHl.style, { display: 'block', left: `${o.x + r.x}px`, top: `${o.y + v.y}px`, width: `${r.w}px`, height: `${v.h}px` });
    if (follow) this._follow(mbb, x);
    this._lastBar = mi;
  }

  showLoop(miStart, miEnd) {
    const lk = this._lookup();
    if (!this.rendered || !lk || miStart == null) { this.loopHl.style.display = 'none'; return; }
    // Only highlight when the loop sits within one line; otherwise outline the first bar.
    const a = lk.findMasterBarByIndex(miStart), b = lk.findMasterBarByIndex(miEnd);
    if (!a || !b) { this.loopHl.style.display = 'none'; return; }
    const sameLine = Math.abs(a.visualBounds.y - b.visualBounds.y) < 1;
    const x0 = a.realBounds.x, x1 = sameLine ? b.realBounds.x + b.realBounds.w : a.realBounds.x + a.realBounds.w;
    const o = this._off();
    Object.assign(this.loopHl.style, {
      display: 'block', left: `${o.x + x0}px`, width: `${x1 - x0}px`,
      top: `${o.y + a.visualBounds.y}px`, height: `${a.visualBounds.h}px`,
    });
  }

  _follow(mbb, x) {
    const sc = this.scroller;
    const v = mbb.visualBounds;
    const o = this._off();
    const offTop = o.y + this.host.offsetTop;
    const offLeft = o.x + this.host.offsetLeft;
    if (this.layout === 'horizontal') {
      const target = offLeft + x - sc.clientWidth * 0.3;
      // Jump when far behind (after a seek); otherwise glide. A smooth scrollTo
      // restarted on every frame never catches up with the cursor.
      if (Math.abs(sc.scrollLeft - target) > sc.clientWidth * 0.6) sc.scrollLeft = target;
      else sc.scrollLeft += (target - sc.scrollLeft) * 0.15;
    } else {
      const key = Math.round(v.y);
      if (key !== this._lastScrollKey) {
        this._lastScrollKey = key;
        const target = offTop + v.y - Math.min(80, sc.clientHeight * 0.15);
        sc.scrollTo({ top: target, behavior: 'smooth' });
      }
    }
  }

  _onClick(e) {
    const lk = this._lookup();
    if (!lk) return;
    const surf = this.surfaceHost?.querySelector('.at-surface');
    if (!surf) return;
    const rect = surf.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const beat = lk.getBeatAtPos(x, y);
    let mi = beat?.voice?.bar?.masterBar?.index;
    if (mi == null) {
      // fall back: nearest master bar on the clicked line
      const n = this.score?.masterBars.length || 0;
      for (let i = 0; i < n; i++) {
        const b = lk.findMasterBarByIndex(i);
        if (!b) continue;
        const r = b.realBounds, v = b.visualBounds;
        if (x >= r.x && x <= r.x + r.w && y >= v.y - 10 && y <= v.y + v.h + 10) { mi = i; break; }
      }
    }
    if (mi != null) {
      let frac = 0;
      if (beat) {
        const ticks = this.score.masterBars[mi].calculateDuration?.() || 3840;
        frac = Math.min(0.999, beat.playbackStart / ticks);
      }
      this.dispatchEvent(new CustomEvent('barclick', { detail: { masterIndex: mi, frac } }));
    }
  }
}

/** Expand repeats and alternate endings into a playback order of master bar indexes. */
export function expandRepeats(mbs) {
  const order = [];
  let i = 0, repeatStart = 0, pass = 1, guard = 0, jumped = false, pendingReset = false;
  while (i < mbs.length && guard++ < 20000) {
    const mb = mbs[i];
    if (pendingReset && !mb.alternateEndings) { pass = 1; pendingReset = false; }
    if (mb.isRepeatStart && !jumped) { repeatStart = i; pass = 1; pendingReset = false; }
    jumped = false;
    if (mb.alternateEndings && !(mb.alternateEndings & (1 << (pass - 1)))) { i++; continue; }
    order.push(i);
    if (mb.repeatCount > 0 && pass < mb.repeatCount) {
      pass++;
      i = repeatStart;
      jumped = true;
      continue;
    }
    if (mb.repeatCount > 0) {
      // repeat finished; following alternate endings use the final pass number
      repeatStart = i + 1;
      pendingReset = true;
    }
    i++;
  }
  return order;
}

/** Bars in playback order with time signature, tempo and section, for the timeline. */
export function scoreBarDefs(score) {
  const mbs = score.masterBars;
  const tempoAt = [];
  let tempo = score.tempo || 120;
  for (const mb of mbs) {
    const a = (mb.tempoAutomations || [])[0] || mb.tempoAutomation;
    if (a && a.value) tempo = a.value;
    tempoAt.push(tempo);
  }
  return expandRepeats(mbs).map((mi) => {
    const mb = mbs[mi];
    const num = mb.timeSignatureNumerator, den = mb.timeSignatureDenominator;
    const name = mb.section ? (mb.section.text || '').trim() : '';
    return {
      masterIndex: mi,
      number: mi + 1,
      beats: beatsForSignature(num, den),
      quarters: num * 4 / den,
      tempo: tempoAt[mi],
      section: name || null,
    };
  });
}
