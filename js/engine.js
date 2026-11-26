// Audio engine: plays every stem in lock-step from one AudioContext clock.
//
// Tempo change keeps pitch: all stems play with the same playbackRate (which
// changes speed *and* pitch together, so they never drift apart), then the
// mixed signal goes through a Signalsmith Stretch pitch shifter that shifts the
// pitch back by the same amount. At 100% speed the shifter is bypassed.

import SignalsmithStretch from '../vendor/signalsmith-stretch.mjs';

const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

export class Engine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.stems = [];          // {id, name, gain, channels, pcm|buffer, volume, muted, solo}
    this.player = null;       // stem-player AudioWorkletNode (when this.pcm)
    this.rate = 1;
    this.playing = false;
    this.anchorCtx = 0;       // ctx time at which anchorPos is heard
    this.anchorPos = 0;       // song position (s) at anchorCtx
    this.duration = 0;
    this.loop = { enabled: false, a: 0, b: 0 };
    this.sources = [];
    this.clickEnabled = false;
    this.clickVolume = 0.7;
    this.beats = [];          // beat times (s) in the audio
    this.downbeats = new Set(); // indexes into beats that start a bar
    this.stretch = null;
    this.wetLatency = 0;
    this._clickRaw = 0;
    this._timer = null;
  }

  async init({ sampleRate } = {}) {
    if (this.ctx) return;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    const AC = window.AudioContext || window.webkitAudioContext;
    // Decoded audio is resampled to the context's rate. Song stems are 44.1 kHz, so a
    // 44.1 kHz context avoids the ~9% extra memory of resampling to 48 kHz.
    const opts = { latencyHint: 'playback', sampleRate: sampleRate || 44100 };
    try { this.ctx = new AC(opts); } catch { this.ctx = new AC(); }
    const c = this.ctx;
    // A phone call, Siri or another app can interrupt the audio. Pause so the
    // position and the play button stay true, instead of freezing mid-play.
    c.addEventListener?.('statechange', () => {
      if (c.state !== 'running' && this.playing) {
        this.anchorPos = this.position;
        this.playing = false;
        clearInterval(this._timer);
        this._killSources();
        this.dispatchEvent(new Event('state'));
      }
    });
    this.bus = c.createGain();
    this.dry = c.createGain();
    this.wet = c.createGain();
    this.master = c.createGain();
    this.wet.gain.value = 0;
    this.bus.connect(this.dry);
    this.dry.connect(this.master);
    this.wet.connect(this.master);
    this.master.connect(c.destination);

    this.clickBus = c.createGain();
    this.clickBus.gain.value = this.clickVolume;
    this.clickDelay = c.createDelay(2);
    this.clickBus.connect(this.clickDelay);
    this.clickDelay.connect(this.master);

    try {
      this.stretch = await SignalsmithStretch(c, {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      });
      this.bus.connect(this.stretch);
      this.stretch.connect(this.wet);
      this.wetLatency = await this.stretch.latency();
      await this.stretch.schedule({ active: false });
    } catch (e) {
      console.warn('Pitch-preserving stretch unavailable; tempo will change pitch.', e);
      this.stretch = null;
    }
    // Stems play from 16-bit samples in a worklet (half the memory of AudioBuffers,
    // see stem-player-worklet.js). Without AudioWorklet, fall back to AudioBuffers.
    try {
      await c.audioWorklet.addModule(new URL('./stem-player-worklet.js', import.meta.url));
      this.pcm = true;
    } catch (e) {
      console.warn('Stem player worklet unavailable; using AudioBuffers.', e);
      this.pcm = false;
    }
  }

  /** Must run inside a user gesture on iOS. */
  async unlock() {
    if (!this.ctx) await this.init();
    // iOS before 16.4 has no audioSession API: there, a looping silent <audio>
    // element switches the session to "playback" so the silent switch doesn't
    // mute Web Audio. On newer iOS that element takes over the audio session and
    // leaves the AudioContext "interrupted" (nothing plays until the app is
    // closed), so it is only used when audioSession is missing.
    if (!navigator.audioSession && /iP(hone|ad|od)|Macintosh/.test(navigator.userAgent) && !this._unlockedEl) {
      try {
        const el = new Audio(SILENT_WAV);
        el.setAttribute('playsinline', '');
        el.loop = true;
        el.volume = 0.0001;
        const p = el.play();
        this._unlockedEl = el;
        p?.catch?.(() => { this._unlockedEl = null; });
      } catch {}
    }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    if (this.ctx.state !== 'running') {
      this._started = false; // output was stopped (or interrupted), so it has to wake up again
      // resume() can hang on iOS; don't wait for it forever
      try { await Promise.race([this.ctx.resume(), new Promise(r => setTimeout(r, 1500))]); } catch {}
    }
    // A silent source keeps the output running between plays, so a later start
    // is not clipped while the audio hardware wakes up again.
    if (!this._keepAlive) {
      try {
        const k = this.ctx.createConstantSource();
        k.offset.value = 0;
        k.connect(this.master);
        k.start();
        this._keepAlive = k;
      } catch {}
    }
    return this.ctx.state === 'running';
  }

  async decode(blob) {
    const ab = await blob.arrayBuffer();
    return await new Promise((res, rej) => {
      const p = this.ctx.decodeAudioData(ab, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }

  /**
   * stems: [{id, name, blob, volume?, muted?, solo?}]
   * mono: downmix each stem to one channel to halve memory (phones).
   */
  async loadStems(stems, { mono = false, onProgress } = {}) {
    this.stop();
    for (const s of this.stems) s.gain.disconnect();
    if (this.player) {
      this.player.port.postMessage({ type: 'load', stems: [] });
      this.player.disconnect();
      this.player = null;
    }
    this.stems = [];
    this.duration = 0;
    let i = 0;
    for (const s of stems) {
      onProgress?.(i, stems.length, s.name);
      let buffer;
      try {
        buffer = await this.decode(s.blob);
      } catch (e) {
        throw new Error(`this browser couldn't decode the ${s.name} audio. If the song package uses FLAC, rebuild it with "--codec aac".`);
      }
      // A stem whose left and right are (nearly) the same sounds identical in mono
      // and takes half the memory, which leaves room to keep the others in stereo.
      if (buffer.numberOfChannels > 1 && (mono || this._nearlyMono(buffer))) buffer = this._downmix(buffer);
      const gain = this.ctx.createGain();
      gain.connect(this.bus);
      const entry = {
        id: s.id, name: s.name, gain, channels: buffer.numberOfChannels,
        volume: s.volume ?? 1, muted: !!s.muted, solo: !!s.solo,
      };
      if (this.pcm) entry.pcm = toPcm16(buffer); // the float AudioBuffer is dropped here
      else entry.buffer = buffer;
      this.stems.push(entry);
      this.duration = Math.max(this.duration, buffer.duration);
      buffer = null;
      i++;
      await new Promise(r => setTimeout(r, 0)); // let the float buffer be collected before the next decode
    }
    if (this.pcm && this.stems.length) {
      const n = this.stems.length;
      const node = new AudioWorkletNode(this.ctx, 'stem-player', {
        numberOfInputs: 0, numberOfOutputs: n, outputChannelCount: Array(n).fill(2),
      });
      this.stems.forEach((st, k) => node.connect(st.gain, k));
      const payload = this.stems.map(st => ({ channels: st.pcm.channels, length: st.pcm.length }));
      // Hand the samples to the audio thread; the main thread keeps no copy.
      node.port.postMessage({ type: 'load', stems: payload }, payload.flatMap(p => p.channels.map(c => c.buffer)));
      for (const st of this.stems) st.pcm = { length: st.pcm.length };
      node.port.onmessage = (e) => { if (e.data?.type === 'ended') this._onEnded(); };
      this.player = node;
    }
    onProgress?.(stems.length, stems.length, '');
    this._applyGains();
    this.anchorPos = 0;
    this.dispatchEvent(new Event('change'));
  }

  /** True when the side (L−R) signal is under about −40 dB of the mid (L+R). */
  _nearlyMono(buf) {
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    let mid = 0, side = 0;
    for (let k = 0; k < L.length; k += 7) {
      const m = L[k] + R[k], d = L[k] - R[k];
      mid += m * m; side += d * d;
    }
    return mid > 0 && side < mid * 1e-4;
  }

  _downmix(buf) {
    const out = this.ctx.createBuffer(1, buf.length, buf.sampleRate);
    const o = out.getChannelData(0);
    const n = buf.numberOfChannels;
    for (let c = 0; c < n; c++) {
      const d = buf.getChannelData(c);
      for (let k = 0; k < d.length; k++) o[k] += d[k] / n;
    }
    return out;
  }

  setStem(id, patch) {
    const s = this.stems.find(x => x.id === id);
    if (!s) return;
    Object.assign(s, patch);
    this._applyGains();
  }

  _applyGains() {
    const anySolo = this.stems.some(s => s.solo);
    const t = this.ctx ? this.ctx.currentTime : 0;
    for (const s of this.stems) {
      const on = !s.muted && (!anySolo || s.solo);
      const v = on ? s.volume : 0;
      s.gain.gain.setTargetAtTime(v, t, 0.015);
    }
  }

  // ---------- transport ----------

  get outLatency() {
    if (!this.ctx) return 0;
    const base = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return base + (this._wetOn() ? this.wetLatency : 0);
  }

  _wetOn() { return !!this.stretch && Math.abs(this.rate - 1) > 1e-4; }

  _wrap(p) {
    const { enabled, a, b } = this.loop;
    if (enabled && b > a && p >= b) p = a + ((p - a) % (b - a));
    return p;
  }

  /** Song position (s) that is being heard right now. */
  get position() {
    if (!this.playing) return this.anchorPos;
    const t = this.ctx.currentTime - this.outLatency;
    const raw = this.anchorPos + Math.max(0, t - this.anchorCtx) * this.rate;
    const p = this._wrap(raw);
    return Math.min(p, this.duration);
  }

  /** Seconds left of the count-in, or 0. */
  get countInRemaining() {
    if (!this.playing) return 0;
    return Math.max(0, (this._countInEnd || this.anchorCtx) - (this.ctx.currentTime - this.outLatency));
  }

  async play({ countInBeats = 0 } = {}) {
    if (!this.stems.length) return;
    const ok = await this.unlock();
    if (this.playing) return;
    if (!ok) {
      // The clock would not move, so nothing would play; tell the UI instead.
      this.dispatchEvent(new Event('blocked'));
      return;
    }
    let pos = this.anchorPos;
    if (this.loop.enabled && (pos < this.loop.a || pos >= this.loop.b)) pos = this.loop.a;
    if (pos >= this.duration - 0.05) pos = this.loop.enabled ? this.loop.a : 0;
    // iOS drops the first moments of output while its audio hardware starts up,
    // so the very first start gets a longer lead before any sound is scheduled.
    const lead = this._started ? 0.06 : 0.3;
    this._started = true;
    const now = this.ctx.currentTime + lead;
    this._countInEnd = 0;
    if (countInBeats > 0) {
      // Count in to the next beat of the song (bar 1 often starts a moment into
      // the recording), so the music comes in exactly on "one" after the count.
      const i = lowerBound(this.beats, pos - 0.02);
      const b = this.beats[i];
      const beatLen = this._beatLengthAt(b ?? pos) / this.rate;
      // Any recording before that beat plays under the count-in, in time with it.
      const toBeat = b !== undefined && b >= pos && b - pos < 8 ? (b - pos) / this.rate : 0;
      const one = now + Math.max(beatLen * countInBeats, toBeat);
      for (let k = countInBeats; k >= 1; k--) this._click(one - k * beatLen, k === countInBeats);
      this._countInEnd = one;
      this._start(pos, one - toBeat);
      return;
    }
    this._start(pos, now);
  }

  _start(pos, when) {
    this._killSources();
    const c = this.ctx;
    this._setWet();
    if (this.player) {
      this.player.port.postMessage({ type: 'start', when, pos, rate: this.rate, loop: { ...this.loop } });
    } else for (const s of this.stems) {
      const src = c.createBufferSource();
      src.buffer = s.buffer;
      src.playbackRate.value = this.rate;
      if (this.loop.enabled && this.loop.b > this.loop.a) {
        src.loop = true;
        src.loopStart = this.loop.a;
        src.loopEnd = this.loop.b;
      }
      src.connect(s.gain);
      src.start(when, Math.min(pos, s.buffer.duration));
      this.sources.push(src);
    }
    if (this.sources[0]) this.sources[0].onended = () => this._onEnded();
    this.anchorPos = pos;
    this.anchorCtx = when;
    this._clickRaw = pos;
    this.playing = true;
    clearInterval(this._timer);
    this._timer = setInterval(() => this._scheduleClicks(), 25);
    this._updateMediaSession();
    this.dispatchEvent(new Event('state'));
  }

  _onEnded() {
    if (this.playing && !this.loop.enabled && this.position >= this.duration - 0.1) {
      this.playing = false;
      this.anchorPos = 0;
      this._killSources();
      this.dispatchEvent(new Event('state'));
    }
  }

  _killSources() {
    this.player?.port.postMessage({ type: 'stop' });
    for (const s of this.sources) {
      s.onended = null;
      try { s.stop(); } catch {}
      s.disconnect();
    }
    this.sources = [];
  }

  pause() {
    if (!this.playing) return;
    this.anchorPos = this.position;
    this.playing = false;
    clearInterval(this._timer);
    this._killSources();
    this.dispatchEvent(new Event('state'));
  }

  stop() {
    this.pause();
    this.anchorPos = 0;
  }

  toggle(opts) { return this.playing ? this.pause() : this.play(opts); }

  seek(pos) {
    pos = Math.max(0, Math.min(pos, Math.max(0, this.duration - 0.01)));
    if (this.playing) {
      this._start(pos, this.ctx.currentTime + 0.03);
    } else {
      this.anchorPos = pos;
      this.dispatchEvent(new Event('seek'));
    }
  }

  setLoop(enabled, a = this.loop.a, b = this.loop.b) {
    if (b < a) [a, b] = [b, a];
    this.loop = { enabled: enabled && b - a > 0.05, a, b };
    if (this.playing) {
      let pos = this.position;
      if (this.loop.enabled && (pos < a || pos >= b)) pos = a;
      this._start(pos, this.ctx.currentTime + 0.03);
    } else if (this.loop.enabled && (this.anchorPos < a || this.anchorPos >= b)) {
      this.anchorPos = a;
    }
    this.dispatchEvent(new Event('loop'));
  }

  setRate(rate) {
    rate = Math.max(0.25, Math.min(2, rate));
    if (Math.abs(rate - this.rate) < 1e-6) return;
    if (this.playing) {
      const now = this.ctx.currentTime;
      const pos = this.position;
      this.rate = rate;
      // Restart cleanly so the pitch shifter and click track re-anchor together.
      this._start(pos, now + 0.03);
    } else {
      this.rate = rate;
      this._setWet();
    }
    this.dispatchEvent(new Event('rate'));
  }

  _setWet() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const wetOn = this._wetOn();
    if (this.stretch) {
      this.stretch.schedule({ active: wetOn, semitones: wetOn ? -12 * Math.log2(this.rate) : 0 });
    }
    this.dry.gain.setTargetAtTime(wetOn ? 0 : 1, t, 0.01);
    this.wet.gain.setTargetAtTime(wetOn ? 1 : 0, t, 0.01);
    this.clickDelay.delayTime.setValueAtTime(wetOn ? this.wetLatency : 0, t);
  }

  // ---------- click track ----------

  setBeatGrid(beats, downbeatIdx) {
    this.beats = beats || [];
    this.downbeats = new Set(downbeatIdx || []);
  }

  setClick(enabled) {
    this.clickEnabled = enabled;
    if (this.playing) this._clickRaw = this.anchorPos + Math.max(0, this.ctx.currentTime - this.anchorCtx) * this.rate;
  }

  setClickVolume(v) {
    this.clickVolume = v;
    if (this.clickBus) this.clickBus.gain.value = v;
  }

  _clickDelay() { return 0; } // delay node handles wet latency

  _beatLengthAt(pos) {
    const b = this.beats;
    if (b.length < 2) return 60 / 100;
    let i = lowerBound(b, pos);
    i = Math.max(1, Math.min(b.length - 1, i));
    return b[i] - b[i - 1];
  }

  _scheduleClicks() {
    if (!this.playing || !this.clickEnabled || !this.beats.length) return;
    const now = this.ctx.currentTime;
    const until = now + 0.2;
    const rawUntil = this.anchorPos + (until - this.anchorCtx) * this.rate;
    const { enabled, a, b } = this.loop;
    const L = b - a;
    let guard = 0;
    while (this._clickRaw < rawUntil && guard++ < 64) {
      let p = this._clickRaw, off = 0;
      if (enabled && L > 0 && p >= b) {
        const k = Math.floor((p - a) / L);
        off = k * L; p -= off;
      }
      const segEnd = enabled && L > 0 && p < b ? b : Infinity;
      const i = lowerBound(this.beats, p - 1e-6);
      const bt = this.beats[i];
      if (bt === undefined || bt >= segEnd) {
        if (segEnd === Infinity) { this._clickRaw = Infinity; break; }
        this._clickRaw = segEnd + off;
        continue;
      }
      const r = bt + off;
      if (r >= rawUntil) break;
      const when = this.anchorCtx + (r - this.anchorPos) / this.rate;
      if (when >= now - 0.005) this._click(when, this.downbeats.has(i));
      this._clickRaw = r + 1e-4;
    }
  }

  _click(when, accent) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'square';
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.32, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g); g.connect(this.clickBus);
    o.start(when); o.stop(when + 0.06);
  }

  // ---------- lock screen ----------

  setMediaInfo(title, artist) {
    this._media = { title, artist };
    this._updateMediaSession();
  }

  _updateMediaSession() {
    if (!('mediaSession' in navigator) || !this._media) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: this._media.title, artist: this._media.artist || '' });
      navigator.mediaSession.setActionHandler('play', () => this.play());
      navigator.mediaSession.setActionHandler('pause', () => this.pause());
    } catch {}
  }
}

export function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < x) lo = m + 1; else hi = m;
  }
  return lo;
}

/** AudioBuffer -> {channels: Int16Array[], length}. Lossless for 16-bit sources. */
function toPcm16(buf) {
  const channels = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const f = buf.getChannelData(c);
    const d = new Int16Array(f.length);
    for (let k = 0; k < f.length; k++) {
      const v = Math.round(f[k] * 32768);
      d[k] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    channels.push(d);
  }
  return { channels, length: buf.length };
}
