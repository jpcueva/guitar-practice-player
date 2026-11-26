// Turns picked files into a stored song.
//
// Accepts any of:
//  - a song package .zip (song.json + stems/*.m4a + optional tab), made by tools/make_song_package.py
//  - a Moises export .zip (one WAV per stem, including "metronome")
//  - loose audio files (+ optional Guitar Pro / MusicXML tab, + optional song.json)

import { detectBeats, parseMoisesName } from './beats.js';
import * as lib from './library.js';

const AUDIO_RE = /\.(wav|mp3|m4a|aac|mp4|ogg|oga|opus|flac|caf|aif|aiff|webm)$/i;
const TAB_RE = /\.(gp|gp3|gp4|gp5|gpx|musicxml|mxl|xml|cap|tex|alphatex)$/i;

const STEM_NAMES = {
  vocals: 'Vocals', backing_vocals: 'Backing vocals', drums: 'Drums', bass: 'Bass',
  lead: 'Lead guitar', rhythm: 'Rhythm guitar', guitar: 'Guitar', other: 'Other',
  piano: 'Piano', keys: 'Keys', strings: 'Strings', wind: 'Wind', synth: 'Synth',
  acoustic: 'Acoustic guitar', electric: 'Electric guitar', metronome: 'Metronome',
};
const STEM_ORDER = ['lead', 'rhythm', 'guitar', 'acoustic', 'electric', 'bass', 'drums', 'vocals', 'backing_vocals', 'keys', 'piano', 'synth', 'strings', 'wind', 'other'];

export function slugify(s) {
  return (s || 'song').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'song';
}

async function expand(files, onStatus) {
  const out = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      onStatus?.(`Opening ${f.name}…`);
      const zip = await window.JSZip.loadAsync(f);
      const entries = Object.values(zip.files).filter(e => !e.dir && !/(^|\/)(__MACOSX|\.)/.test(e.name));
      for (const e of entries) {
        out.push({ name: e.name.replace(/^.*\//, ''), path: e.name, zipName: f.name, getBlob: () => e.async('blob') });
      }
    } else {
      out.push({ name: f.name, path: f.name, getBlob: async () => f });
    }
  }
  return out;
}

/**
 * @param {File[]} files
 * @param {{decode:(Blob)=>Promise<AudioBuffer>, onStatus?:(msg)=>void}} opts
 * @returns {Promise<object>} the stored song record
 */
export async function importFiles(files, { decode, onStatus }) {
  const items = await expand(files, onStatus);
  const songJsonItem = items.find(i => /(^|\/)song\.json$/i.test(i.path));
  const audio = items.filter(i => AUDIO_RE.test(i.name));
  const tabItem = items.find(i => TAB_RE.test(i.name) && !/song\.json$/i.test(i.name));

  let meta;
  const toStore = [];

  if (songJsonItem) {
    meta = JSON.parse(await (await songJsonItem.getBlob()).text());
    const base = songJsonItem.path.replace(/song\.json$/i, '');
    for (const s of meta.stems || []) {
      const it = items.find(i => i.path === base + s.file) || items.find(i => i.name === s.file.replace(/^.*\//, ''));
      if (!it) throw new Error(`The package is missing ${s.file}.`);
      toStore.push({ path: s.file, item: it });
    }
    if (meta.tab) {
      const it = items.find(i => i.path === base + meta.tab) || items.find(i => i.name === meta.tab.replace(/^.*\//, ''));
      if (it) toStore.push({ path: meta.tab, item: it });
      else meta.tab = null;
    }
    // A tab picked alongside the package wins over (or fills in for) the packaged one.
    const looseTab = items.find(i => TAB_RE.test(i.name) && !i.zipName);
    if (looseTab) {
      if (meta.tab) toStore.splice(toStore.findIndex(t => t.path === meta.tab), 1);
      meta.tab = `tab${looseTab.name.match(/\.[a-z0-9]+$/i)[0].toLowerCase()}`;
      toStore.push({ path: meta.tab, item: looseTab });
    }
  } else {
    if (!audio.length) throw new Error('No audio files found. Pick a Moises export (.zip or WAV files) or a song package.');
    const parsed = audio.map(a => ({ a, p: parseMoisesName(a.name) }));
    const fromZip = audio[0].zipName ? parseMoisesName(audio[0].zipName) : null;
    const first = parsed.find(x => x.p.bpm) || parsed[0];
    const title = (first.p.bpm ? first.p.title : null) || (fromZip && fromZip.title) || 'Untitled song';
    meta = {
      format: 1, id: slugify(title), title, artist: '',
      key: first.p.key || fromZip?.key || null, bpm: first.p.bpm || fromZip?.bpm || null,
      stems: [], tab: null, beats: [],
      sync: { barOffset: 0, beatsPerBar: 4, nudgeMs: 0 }, sections: [],
    };
    const used = new Set();
    for (const { a, p } of parsed) {
      let id = slugify(p.stem || a.name).replace(/-/g, '_');
      if (id === 'metronome' || /metronome|click/i.test(a.name)) {
        onStatus?.('Reading the metronome track to find the beats…');
        const buf = await decode(await a.getBlob());
        const chans = [];
        for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
        meta.beats = detectBeats(chans, buf.sampleRate, meta.bpm);
        continue;
      }
      while (used.has(id)) id += '_2';
      used.add(id);
      const ext = a.name.match(/\.[a-z0-9]+$/i)[0].toLowerCase();
      const file = `stems/${id}${ext}`;
      meta.stems.push({ id, name: STEM_NAMES[p.stem] || prettify(p.stem || a.name), file });
      toStore.push({ path: file, item: a });
    }
    meta.stems.sort((x, y) => rank(x.id) - rank(y.id));
    if (tabItem) {
      const file = `tab${tabItem.name.match(/\.[a-z0-9]+$/i)[0].toLowerCase()}`;
      meta.tab = file;
      toStore.push({ path: file, item: tabItem });
    }
  }

  const existing = await lib.getSong(meta.id);
  if (existing) await lib.deleteSong(meta.id);

  const blobs = [];
  let bytes = 0;
  for (const s of toStore) {
    onStatus?.(`Unpacking ${s.item.name}…`);
    const blob = await s.item.getBlob();
    bytes += blob.size;
    blobs.push({ path: s.path, blob });
  }
  await lib.requestPersist();
  await lib.putFiles(meta.id, blobs, (i, n) => onStatus?.(`Saving for offline use (${i + 1}/${n})…`));
  const record = { ...meta, addedAt: Date.now(), bytes, prefs: existing?.prefs || {} };
  await lib.putSong(record);
  return record;
}

export async function attachTab(songId, file) {
  const song = await lib.getSong(songId);
  if (/\.zip$/i.test(file.name)) {
    // PDF tab bundle from tools/pdf_tab_bundle.py
    const zip = await window.JSZip.loadAsync(file);
    const jsonEntry = zip.file('tab.json');
    if (!jsonEntry) throw new Error('That .zip is not a tab bundle (no tab.json inside).');
    const bundle = JSON.parse(await jsonEntry.async('text'));
    if (bundle.kind !== 'pdf-tab') throw new Error('Unknown tab bundle.');
    const files = [{ path: 'tab.json', blob: new Blob([JSON.stringify(bundle)], { type: 'application/json' }) }];
    let bytes = 0;
    for (const part of bundle.parts) {
      for (const pg of part.pages) {
        const e = zip.file(pg.file);
        if (!e) throw new Error(`The bundle is missing ${pg.file}.`);
        const blob = await e.async('blob');
        bytes += blob.size;
        files.push({ path: pg.file, blob: new Blob([blob], { type: 'image/webp' }) });
      }
    }
    await lib.putFiles(songId, files);
    song.tab = 'tab.json';
    song.bytes = (song.bytes || 0) + bytes;
  } else {
    if (!TAB_RE.test(file.name)) throw new Error('That is not a tab file. Use Guitar Pro (.gp, .gp5, .gpx), MusicXML, or a PDF tab bundle (.zip).');
    const path = `tab${file.name.match(/\.[a-z0-9]+$/i)[0].toLowerCase()}`;
    await lib.putFiles(songId, [{ path, blob: file }]);
    song.tab = path;
    song.bytes = (song.bytes || 0) + file.size;
  }
  if (song.sync) song.sync.alignedFor = null;
  song.prefs = { ...(song.prefs || {}), trackIndex: null };
  await lib.putSong(song);
  return song;
}

function rank(id) {
  const i = STEM_ORDER.indexOf(id);
  return i < 0 ? 99 : i;
}

function prettify(s) {
  s = s.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
