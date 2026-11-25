// Beat grid from a Moises "metronome" stem.
//
// The metronome stem is a click on every beat that follows the recording's real
// tempo. Moises sometimes clicks eighth notes instead of quarters (e.g. a
// half-time intro), so clicks faster than ~1.6x the song's nominal BPM are
// thinned out to every other one.

/**
 * @param {Float32Array[]} channels decoded audio channels
 * @param {number} sampleRate
 * @param {number|null} refBpm nominal tempo (from the Moises file name), optional
 * @returns {number[]} beat times in seconds
 */
export function detectBeats(channels, sampleRate, refBpm = null) {
  const n = channels[0].length;
  const hop = 32;
  const frames = Math.floor(n / hop);
  const env = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let m = 0;
    const s = f * hop;
    for (const ch of channels) {
      for (let k = s; k < s + hop; k++) {
        const v = Math.abs(ch[k]);
        if (v > m) m = v;
      }
    }
    env[f] = m;
    if (m > peak) peak = m;
  }
  if (peak <= 0) return [];
  const thr = peak * 0.5;
  const refractory = 0.09;
  const clicks = [];
  let last = -1e9;
  for (let f = 0; f < frames; f++) {
    if (env[f] > thr) {
      const t = (f * hop) / sampleRate;
      if (t - last > refractory) { clicks.push(t); last = t; }
    }
  }
  return foldBeats(clicks, refBpm);
}

export function foldBeats(clicks, refBpm) {
  if (clicks.length < 3) return clicks;
  let ref = refBpm;
  if (!ref) {
    const d = [];
    for (let i = 1; i < clicks.length; i++) d.push(clicks[i] - clicks[i - 1]);
    d.sort((x, y) => x - y);
    ref = 60 / d[Math.floor(d.length / 2)];
  }
  const minInterval = 60 / (ref * 1.6);
  const out = [clicks[0]];
  for (let i = 1; i < clicks.length; i++) {
    if (clicks[i] - out[out.length - 1] >= minInterval * 0.92) out.push(clicks[i]);
  }
  return out.map(t => Math.round(t * 10000) / 10000);
}

/** Parse "Title-stem-Key-106bpm-440hz" style Moises names. */
export function parseMoisesName(filename) {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '');
  const m = base.match(/^(.*)-([a-z_ ]+?)-([^-]+)-(\d+(?:\.\d+)?)bpm-(\d+)hz$/i);
  if (m) return { title: m[1].trim(), stem: m[2].trim().toLowerCase(), key: m[3].trim(), bpm: +m[4], tuningHz: +m[5] };
  const m2 = base.match(/^(.*)-([^-]+)-(\d+(?:\.\d+)?)bpm-(\d+)hz$/i); // folder / zip name
  if (m2) return { title: m2[1].trim(), stem: null, key: m2[2].trim(), bpm: +m2[3], tuningHz: +m2[4] };
  return { title: base, stem: base.toLowerCase(), key: null, bpm: null, tuningHz: null };
}
