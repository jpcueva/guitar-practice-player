// AudioWorklet that plays every stem from 16-bit samples, one output per stem.
//
// Web Audio's AudioBuffer keeps audio as 32-bit floats, so six stereo stems of
// a 6-minute song take about 800 MB, more than an iPhone allows a web page.
// The stems are 16-bit recordings, so keeping them as 16-bit integers is
// lossless and halves that, which is what lets phones play them in stereo.
//
// Messages from the main thread:
//   {type: 'load', stems: [{channels: [Int16Array, …], length}]}   (buffers transferred)
//   {type: 'start', when, pos, rate, loop: {enabled, a, b}}         when = context time (s)
//   {type: 'stop'}
// Posts {type: 'ended'} when playback reaches the end without a loop.

class StemPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stems = [];
    this.playing = false;
    this.port.onmessage = (e) => this._msg(e.data);
  }

  _msg(m) {
    if (m.type === 'load') {
      this.stems = m.stems;
      this.length = Math.max(0, ...m.stems.map(s => s.length));
      this.playing = false;
    } else if (m.type === 'start') {
      this.startFrame = Math.round(m.when * sampleRate);
      this.idx0 = m.pos * sampleRate;
      this.rate = m.rate;
      this.loopOn = !!(m.loop && m.loop.enabled && m.loop.b > m.loop.a);
      this.la = this.loopOn ? m.loop.a * sampleRate : 0;
      this.lb = this.loopOn ? m.loop.b * sampleRate : 0;
      this.idx = null; // set on the first rendered frame, so a late message still lands in sync
      this.playing = true;
    } else if (m.type === 'stop') {
      this.playing = false;
    }
  }

  process(_inputs, outputs) {
    if (!this.playing || !this.stems.length) return true;
    const n = outputs[0][0].length;
    const f0 = currentFrame;
    let k0 = 0;
    if (this.idx === null) {
      if (f0 + n <= this.startFrame) return true;     // not started yet: silence
      k0 = Math.max(0, this.startFrame - f0);
      // If the start message arrived after its start time, skip ahead to stay on the clock.
      this.idx = this.idx0 + Math.max(0, f0 - this.startFrame) * this.rate;
      if (this.loopOn) this.idx = this._wrap(this.idx);
    }
    const rate = this.rate, S = 1 / 32768;
    const whole = Math.abs(rate - 1) < 1e-9 && Number.isInteger(this.idx);
    let idx = this.idx;
    for (let k = k0; k < n; k++) {
      if (this.loopOn && idx >= this.lb) idx = this._wrap(idx);
      if (idx >= this.length) {
        this.playing = false;
        this.port.postMessage({ type: 'ended' });
        break;
      }
      const i = Math.floor(idx), fr = idx - i;
      for (let s = 0; s < this.stems.length; s++) {
        const st = this.stems[s], out = outputs[s];
        if (!out || i >= st.length) continue;
        const chs = st.channels;
        for (let c = 0; c < out.length; c++) {
          const d = chs[Math.min(c, chs.length - 1)];
          let v;
          if (whole || fr === 0) v = d[i];
          else {
            const nx = i + 1 < st.length ? d[i + 1] : 0;
            v = d[i] + (nx - d[i]) * fr;                 // linear, like AudioBufferSourceNode
          }
          out[c][k] = v * S;
        }
      }
      idx += rate;
    }
    this.idx = idx;
    return true;
  }

  _wrap(idx) {
    const L = this.lb - this.la;
    if (L <= 0) return idx;
    if (idx >= this.lb) idx = this.la + ((idx - this.la) % L);
    return idx;
  }
}

registerProcessor('stem-player', StemPlayer);
