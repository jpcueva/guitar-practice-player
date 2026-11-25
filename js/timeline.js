// Maps song bars <-> audio time using the beat grid.
//
// A "bar" here is one bar in playback order (repeats expanded). Each bar knows
// its start/end time in the recording and the time of each of its beats, so the
// tab cursor follows tempo changes and the band's natural push and pull.

import { lowerBound } from './engine.js';

/**
 * @param {object} o
 * @param {number[]} o.beats           beat times (s)
 * @param {Array|null} o.barDefs       [{masterIndex, number, beats (float), section}] in playback order; null = no tab
 * @param {number} o.barOffset         beat index where bar 1 starts (can be negative)
 * @param {number} o.beatsPerBar       used when there is no tab
 * @param {number} o.duration          audio length (s)
 * @param {Array}  o.sections          fallback sections [{name, bar}] (1-based bar numbers in playback order)
 * @param {number} o.nudge             seconds added to every beat (fine sync)
 */
export function buildTimeline({ beats, barDefs, barOffset = 0, beatsPerBar = 4, duration, sections = [], nudge = 0 }) {
  const B = beats.length ? beats : synthBeats(duration, 120);
  const beatAt = (k) => {
    const n = B.length;
    let t;
    if (n === 1) t = B[0] + k * 0.5;
    else if (k < 0) t = B[0] + k * (B[1] - B[0]);
    else if (k >= n - 1) {
      const span = Math.min(8, n - 1);
      const avg = (B[n - 1] - B[n - 1 - span]) / span;
      t = B[n - 1] + (k - (n - 1)) * avg;
    } else {
      const i = Math.floor(k), f = k - i;
      t = B[i] + f * (B[i + 1] - B[i]);
    }
    return t + nudge;
  };

  let defs = barDefs;
  if (!defs) {
    const count = Math.max(1, Math.ceil((B.length - barOffset) / beatsPerBar));
    defs = Array.from({ length: count }, (_, i) => ({ masterIndex: i, number: i + 1, beats: beatsPerBar, section: null }));
  }

  const bars = [];
  let k = barOffset;
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    const start = beatAt(k);
    const beatTimes = [];
    const whole = Math.ceil(d.beats - 1e-6);
    for (let j = 0; j <= whole; j++) beatTimes.push(beatAt(k + Math.min(j, d.beats)));
    const end = beatAt(k + d.beats);
    bars.push({
      i, masterIndex: d.masterIndex, number: d.number, beats: d.beats,
      start, end, beatTimes, section: d.section || null,
      firstBeatIndex: Number.isInteger(k) ? k : null,
    });
    k += d.beats;
    if (!barDefs && start > duration) break;
  }
  // Drop bars entirely past the end of the audio (no-tab mode).
  while (!barDefs && bars.length > 1 && bars[bars.length - 1].start >= duration) bars.pop();

  // Sections: from the tab, else from song.json, else 8-bar blocks.
  const named = bars.some(b => b.section);
  let secStarts = [];
  if (named) {
    bars.forEach((b, i) => { if (b.section) secStarts.push({ name: b.section, i }); });
    if (secStarts[0]?.i !== 0) secStarts.unshift({ name: 'Start', i: 0 });
  } else if (sections.length) {
    secStarts = sections
      .map(s => ({ name: s.name, i: Math.max(0, Math.min(bars.length - 1, s.bar - 1)) }))
      .sort((a, b) => a.i - b.i);
    if (secStarts[0]?.i !== 0) secStarts.unshift({ name: 'Start', i: 0 });
  } else {
    for (let i = 0; i < bars.length; i += 8) secStarts.push({ name: `Bars ${i + 1}–${Math.min(i + 8, bars.length)}`, i, generic: true });
  }
  const secs = secStarts.map((s, idx) => {
    const endI = (secStarts[idx + 1]?.i ?? bars.length) - 1;
    return {
      name: s.name, generic: !!s.generic, startBar: s.i, endBar: endI,
      start: bars[s.i].start, end: bars[endI].end,
    };
  });

  // Beat indexes that start a bar (for the accented click).
  const downbeats = bars.map(b => b.firstBeatIndex).filter(x => x !== null && x >= 0);

  return {
    bars, sections: secs, downbeats,
    barAt(t) {
      if (!bars.length) return -1;
      let lo = 0, hi = bars.length - 1;
      if (t < bars[0].start) return 0;
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if (bars[m].start <= t) lo = m; else hi = m - 1;
      }
      return lo;
    },
    /** fraction (0..1) through bar i at time t, linear in beats */
    fracInBar(i, t) {
      const b = bars[i];
      if (!b) return 0;
      const bt = b.beatTimes;
      if (t <= bt[0]) return 0;
      if (t >= bt[bt.length - 1]) return 1;
      const j = Math.max(0, lowerBound(bt, t) - 1);
      const seg = (t - bt[j]) / Math.max(1e-6, bt[j + 1] - bt[j]);
      return Math.min(1, (j + seg) / b.beats);
    },
    sectionAt(i) {
      for (let s = secs.length - 1; s >= 0; s--) if (secs[s].startBar <= i) return s;
      return 0;
    },
  };
}

function synthBeats(duration, bpm) {
  const out = [];
  for (let t = 0; t < duration; t += 60 / bpm) out.push(t);
  return out;
}

/** Beats per bar as the metronome counts them, from a time signature. */
export function beatsForSignature(num, den) {
  if (den <= 4) return num * (4 / den);
  if (den === 8 && num % 3 === 0 && num >= 6) return num / 3; // compound: dotted quarters
  return num * (4 / den);
}
