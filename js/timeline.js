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
 * @param {boolean} o.overrideSections use `sections` even when the tab has its own section marks
 * @param {number} o.nudge             seconds added to every beat (fine sync)
 */
export function buildTimeline({ beats, barDefs, barOffset = 0, beatsPerBar = 4, duration, sections = [], overrideSections = false, nudge = 0 }) {
  const B = beats.length ? beats : synthBeats(duration, 120);
  const bars = [];
  let grid, downbeats;

  if (barDefs && barDefs.length && B.length > 2) {
    // Tab mode: walk the tab's beats through the clicks, guided by the tab's tempo map.
    const { units, barUnit } = tabUnits(barDefs);
    const { times } = alignBeats(B, units, barOffset);
    for (let i = 0; i < barDefs.length; i++) {
      const d = barDefs[i];
      const u0 = barUnit[i], u1 = barUnit[i + 1];
      const beatTimes = times.slice(u0, u1 + 1).map(t => t + nudge);
      bars.push({
        i, masterIndex: d.masterIndex, number: d.number, beats: d.beats,
        start: beatTimes[0], end: beatTimes[beatTimes.length - 1], beatTimes, section: d.section || null,
      });
    }
    grid = times.map(t => t + nudge);
    downbeats = barUnit.slice(0, -1);
  } else {
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
    const defs = barDefs && barDefs.length ? barDefs : Array.from(
      { length: Math.max(1, Math.ceil((B.length - barOffset) / beatsPerBar)) },
      (_, i) => ({ masterIndex: i, number: i + 1, beats: beatsPerBar, section: null }));
    let k = barOffset;
    downbeats = [];
    for (let i = 0; i < defs.length; i++) {
      const d = defs[i];
      const beatTimes = [];
      const whole = Math.ceil(d.beats - 1e-6);
      for (let j = 0; j <= whole; j++) beatTimes.push(beatAt(k + Math.min(j, d.beats)));
      if (Number.isInteger(k) && k >= 0) downbeats.push(k);
      bars.push({
        i, masterIndex: d.masterIndex, number: d.number, beats: d.beats,
        start: beatTimes[0], end: beatTimes[beatTimes.length - 1], beatTimes, section: d.section || null,
      });
      k += d.beats;
      if (!barDefs && beatTimes[0] > duration) break;
    }
    while (!barDefs && bars.length > 1 && bars[bars.length - 1].start >= duration) bars.pop();
    grid = B.map(t => t + nudge);
  }

  // Sections: the user's own, else from the tab, else from song.json, else 8-bar blocks.
  const named = !(overrideSections && sections.length) && bars.some(b => b.section);
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

  return {
    bars, sections: secs, grid, downbeats,
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

/**
 * Expected length (s) of every beat in the tab, from its tempo map.
 * units[k] = duration of beat k; barUnit[i] = index of bar i's first beat (length bars+1).
 */
export function tabUnits(barDefs) {
  const units = [], barUnit = [];
  for (const d of barDefs) {
    barUnit.push(units.length);
    const quarter = 60 / (d.tempo || 120);
    const beatLen = (d.quarters || d.beats) * quarter / d.beats;
    const whole = Math.floor(d.beats + 1e-6);
    for (let j = 0; j < whole; j++) units.push(beatLen);
    const frac = d.beats - whole;
    if (frac > 1e-6) units.push(frac * beatLen);
  }
  barUnit.push(units.length);
  return { units, barUnit };
}

/**
 * Walk the tab's beats through the metronome clicks. Each next beat is predicted
 * from the tab tempo (scaled to how the band actually plays) and snapped to the
 * nearest click; clicks in between are skipped (double-time clicking) and a
 * missing click is filled in from the prediction.
 * @returns {{times:number[], matched:number}} times has units.length + 1 entries
 */
export function alignBeats(clicks, units, startIdx = 0) {
  const times = [];
  let t = startIdx >= 0 ? clicks[Math.min(startIdx, clicks.length - 1)] : clicks[0] + startIdx * (units[0] || 0.5);
  let ci = Math.max(0, startIdx) + 1;
  let scale = 1, matched = 0;
  times.push(t);
  for (let k = 0; k < units.length; k++) {
    const d = units[k] * scale;
    const pred = t + d;
    while (ci < clicks.length && clicks[ci] < pred - 0.45 * d) ci++;
    let best = -1, bd = Infinity;
    for (let j = ci; j < clicks.length && clicks[j] <= pred + 0.45 * d; j++) {
      const e = Math.abs(clicks[j] - pred);
      if (e < bd) { bd = e; best = j; }
    }
    let nt = pred;
    if (best >= 0 && bd < 0.22 * d) {
      nt = clicks[best];
      ci = best + 1;
      matched++;
      scale = Math.min(1.1, Math.max(0.9, scale * 0.8 + 0.2 * ((nt - t) / units[k])));
    }
    times.push(nt);
    t = nt;
  }
  return { times, matched };
}

/** Pick the click where bar 1 most likely starts: the offset whose walk matches the most clicks. */
export function autoOffset(clicks, barDefs, maxOffset = 48) {
  const { units } = tabUnits(barDefs);
  let best = 0, bestScore = -1;
  // Try offsets nearest bar 1 = first click first, so ties keep the simplest answer.
  const offs = [0];
  for (let k = 1; k <= maxOffset; k++) { offs.push(k); if (k <= 8) offs.push(-k); }
  for (const off of offs) {
    if (off > clicks.length - 2) continue;
    const { matched } = alignBeats(clicks, units, off);
    if (matched > bestScore + 2) { bestScore = matched; best = off; }
  }
  return { offset: best, matched: bestScore, total: units.length };
}
