import { Engine } from './engine.js';
import { buildTimeline } from './timeline.js';
import { TabView } from './tab.js';
import * as lib from './library.js';
import { importFiles, attachTab } from './importer.js';

const $ = (s) => document.querySelector(s);
const STEM_COLORS = ['#f59e0b', '#fb7185', '#34d399', '#60a5fa', '#a78bfa', '#f472b6', '#22d3ee', '#facc15', '#94a3b8'];
const SECTION_COLORS = ['#f59e0b', '#60a5fa', '#34d399', '#fb7185', '#a78bfa', '#22d3ee', '#f472b6', '#facc15'];
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const globalPrefs = loadGlobalPrefs();
const engine = new Engine();
const tab = new TabView($('#tabHost'), $('#tabScroll'));

let song = null;        // stored record
let barDefs = null;     // from tab
let tracks = [];
let tl = null;          // timeline
let loopSel = null;     // {startBar, endBar} in timeline bar indexes, null = whole song
let countIn = false;
let lastUi = {};

// ---------------- helpers ----------------

function loadGlobalPrefs() {
  const d = { layout: 'page', scale: window.innerWidth < 500 ? 0.9 : 1, stereo: !isIOS, lastSong: null };
  try { return { ...d, ...JSON.parse(localStorage.getItem('gpp.prefs') || '{}') }; } catch { return d; }
}
function saveGlobalPrefs() { try { localStorage.setItem('gpp.prefs', JSON.stringify(globalPrefs)); } catch {} }

const fmt = (t) => {
  t = Math.max(0, t || 0);
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
};

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}
function busy(msg) {
  $('#busy').hidden = !msg;
  if (msg) $('#busyMsg').textContent = msg;
}

let saveTimer;
function saveSongSoon() {
  if (!song) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => lib.putSong(song).catch(e => console.warn(e)), 400);
}

function prefs() {
  song.prefs ||= {};
  return song.prefs;
}

// ---------------- sheets ----------------

function openSheet(id) {
  closeSheets();
  $(id).hidden = false;
  $('#backdrop').hidden = false;
  if (id === '#library') renderLibrary();
  if (id === '#mixer') renderMixer();
  if (id === '#settings') renderSettings();
}
function closeSheets() {
  for (const el of document.querySelectorAll('.sheet')) el.hidden = true;
  $('#backdrop').hidden = true;
}
$('#backdrop').addEventListener('click', closeSheets);
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
$('#btnLibrary').addEventListener('click', () => openSheet('#library'));
$('#btnWelcomeAdd').addEventListener('click', () => openSheet('#library'));
$('#btnMixer').addEventListener('click', () => openSheet('#mixer'));
$('#btnSettings').addEventListener('click', () => openSheet('#settings'));

// ---------------- library ----------------

async function renderLibrary() {
  const list = $('#songList');
  const songs = await lib.listSongs();
  list.innerHTML = '';
  if (!songs.length) list.innerHTML = '<li class="hint">No songs yet.</li>';
  for (const s of songs) {
    const li = document.createElement('li');
    if (song && s.id === song.id) li.classList.add('active');
    const mb = s.bytes ? `${Math.round(s.bytes / 1e6)} MB` : '';
    li.innerHTML = `
      <button class="song-open"><b></b><small></small></button>
      <div class="song-actions">
        <label class="chip-btn">${s.tab ? 'Replace tab' : 'Add tab'}<input type="file" accept=".gp,.gp3,.gp4,.gp5,.gpx,.xml,.musicxml,.mxl" /></label>
        <button class="chip-btn del">Delete</button>
      </div>`;
    li.querySelector('b').textContent = s.title;
    li.querySelector('small').textContent = [s.artist, `${s.stems.length} stems`, s.tab ? 'tab' : 'no tab', mb].filter(Boolean).join(' · ');
    li.querySelector('.song-open').addEventListener('click', () => { closeSheets(); openSong(s.id); });
    li.querySelector('input').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        await attachTab(s.id, f);
        toast('Tab added.');
        closeSheets();
        await openSong(s.id);
      } catch (err) { toast(err.message || String(err), 6000); }
    });
    li.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`Delete "${s.title}" from this device?`)) return;
      await lib.deleteSong(s.id);
      if (song?.id === s.id) { engine.stop(); song = null; showWelcome(true); }
      renderLibrary();
    });
    list.appendChild(li);
  }
  const st = await lib.storageInfo();
  $('#storage').textContent = st.usage != null
    ? `Using ${Math.round(st.usage / 1e6)} MB of ${Math.round(st.quota / 1e6)} MB available${st.persisted ? ' · saved permanently' : ''}.`
    : '';
}

$('#fileAdd').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  closeSheets();
  try {
    await engine.init();
    busy('Importing…');
    const rec = await importFiles(files, { decode: (b) => engine.decode(b), onStatus: busy });
    busy(null);
    toast(`Added "${rec.title}"${rec.beats?.length ? ` · ${rec.beats.length} beats found` : ''}.`);
    await openSong(rec.id);
  } catch (err) {
    console.error(err);
    busy(null);
    toast(`Couldn't add the song: ${err.message || err}`, 8000);
  }
});

// ---------------- song loading ----------------

function showWelcome(on) {
  $('#welcome').hidden = !on;
  if (on) {
    $('#songTitle').textContent = 'No song loaded';
    $('#songSub').textContent = 'Tap ☰ to add a song';
    $('#tabHost').innerHTML = '';
    $('#noTab').hidden = true;
    $('#trackSelect').hidden = true;
    $('#sectionMap').innerHTML = '';
  }
}

async function openSong(id) {
  const rec = await lib.getSong(id);
  if (!rec) return showWelcome(true);
  engine.stop();
  song = rec;
  globalPrefs.lastSong = id;
  saveGlobalPrefs();
  showWelcome(false);
  $('#songTitle').textContent = song.title;
  $('#songSub').textContent = [song.artist, song.key, song.bpm ? `${song.bpm} BPM` : null].filter(Boolean).join(' · ');
  song.sync ||= { barOffset: 0, beatsPerBar: 4, nudgeMs: 0 };
  const p = prefs();

  try {
    await engine.init();
    busy('Loading audio…');
    const stems = [];
    for (const s of song.stems) {
      const blob = await lib.getFile(song.id, s.file);
      if (!blob) throw new Error(`Missing audio for ${s.name}. Try adding the song again.`);
      const sp = p.stems?.[s.id] || {};
      stems.push({ id: s.id, name: s.name, blob, volume: sp.volume ?? 1, muted: sp.muted, solo: sp.solo });
    }
    await engine.loadStems(stems, {
      mono: !globalPrefs.stereo,
      onProgress: (i, n, name) => busy(i < n ? `Loading audio ${i + 1}/${n}: ${name}…` : 'Almost ready…'),
    });
    engine.setMediaInfo(song.title, song.artist);

    barDefs = null;
    tracks = [];
    if (song.tab) {
      busy('Drawing the tab…');
      const blob = await lib.getFile(song.id, song.tab);
      tab.layout = globalPrefs.layout;
      tab.scale = globalPrefs.scale;
      $('#tabHost').classList.toggle('horizontal', globalPrefs.layout === 'horizontal');
      try {
        const info = await withTimeout(tab.load(await blob.arrayBuffer(), p.trackIndex ?? null), 30000);
        barDefs = info.barDefs;
        tracks = info.tracks;
        p.trackIndex = info.trackIndex;
        if (!song.artist && info.artist) { song.artist = info.artist; $('#songSub').textContent = [song.artist, song.key].filter(Boolean).join(' · '); }
      } catch (err) {
        console.error(err);
        toast(`The tab file couldn't be read: ${err.message || err}`, 7000);
        tab.destroy();
        $('#tabHost').innerHTML = '';
      }
    } else {
      tab.destroy();
      $('#tabHost').innerHTML = '';
    }
    renderTrackSelect();
    $('#noTab').hidden = !!barDefs;
    if (!song.beats?.length) $('#noTabHint').textContent = 'No metronome track was found, so bars are estimated at 120 BPM. Include the Moises "metronome" stem when adding the song.';
    else $('#noTabHint').innerHTML = 'No tab for this song yet. Add a Guitar Pro or MusicXML file in Songs → <b>Add tab</b>.';

    // restore practice settings
    engine.setRate((p.rate || 100) / 100);
    $('#tempo').value = p.rate || 100;
    updateTempoLabel();
    engine.setClick(!!p.click);
    setPressed($('#btnClick'), !!p.click);
    countIn = !!p.countIn;
    setPressed($('#btnCountIn'), countIn);
    engine.setClickVolume(p.clickVolume ?? 0.7);
    $('#clickVol').value = p.clickVolume ?? 0.7;

    rebuildTimeline();
    loopSel = p.loop && p.loop.startBar != null && tl.bars[p.loop.endBar] ? { startBar: p.loop.startBar, endBar: p.loop.endBar } : null;
    engine.seek(0);
    applyLoop(!!p.loop?.enabled, false);
    busy(null);
  } catch (err) {
    console.error(err);
    busy(null);
    toast(`Couldn't open the song: ${err.message || err}`, 8000);
  }
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
}

function renderTrackSelect() {
  const sel = $('#trackSelect');
  sel.hidden = tracks.length < 1;
  sel.innerHTML = '';
  for (const t of tracks) {
    const o = document.createElement('option');
    o.value = t.index;
    o.textContent = t.name;
    sel.appendChild(o);
  }
  sel.value = prefs().trackIndex ?? 0;
}
$('#trackSelect').addEventListener('change', (e) => {
  const i = +e.target.value;
  prefs().trackIndex = i;
  saveSongSoon();
  tab.setTrack(i);
});
tab.addEventListener('rendered', () => { lastUi.mi = -1; showLoopOnTab(); });
tab.addEventListener('barclick', (e) => {
  if (!tl) return;
  const { masterIndex, frac } = e.detail;
  const cur = tl.barAt(engine.position);
  // choose the occurrence of this bar closest to where we are now
  let best = -1, bestD = Infinity;
  tl.bars.forEach((b, i) => {
    if (b.masterIndex === masterIndex) {
      const d = Math.abs(i - cur);
      if (d < bestD) { bestD = d; best = i; }
    }
  });
  if (best >= 0) {
    const b = tl.bars[best];
    engine.seek(b.start + frac * (b.end - b.start));
  }
});

// ---------------- timeline / sections ----------------

function rebuildTimeline() {
  const nudge = (song.sync.nudgeMs || 0) / 1000;
  tl = buildTimeline({
    beats: song.beats || [],
    barDefs,
    barOffset: song.sync.barOffset || 0,
    beatsPerBar: song.sync.beatsPerBar || 4,
    duration: engine.duration,
    sections: song.sections || [],
    nudge,
  });
  engine.setBeatGrid((song.beats || []).map(b => b + nudge), tl.downbeats);
  renderSections();
  renderProgressSections();
  lastUi = {};
  if (loopSel && !tl.bars[loopSel.endBar]) loopSel = null;
}

function renderSections() {
  const map = $('#sectionMap');
  map.innerHTML = '';
  tl.sections.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'sec-chip';
    b.style.setProperty('--c', SECTION_COLORS[i % SECTION_COLORS.length]);
    b.innerHTML = `<span></span><small></small>`;
    b.querySelector('span').textContent = s.name;
    b.querySelector('small').textContent = s.generic ? '' : `${s.endBar - s.startBar + 1}`;
    b.title = `Bars ${s.startBar + 1}–${s.endBar + 1}. Tap to jump and select; long-press to extend the selection.`;
    let pressTimer = null, long = false;
    b.addEventListener('pointerdown', () => {
      long = false;
      pressTimer = setTimeout(() => { long = true; extendSelection(i); }, 500);
    });
    const cancel = () => clearTimeout(pressTimer);
    b.addEventListener('pointerup', cancel);
    b.addEventListener('pointerleave', cancel);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      if (long) return;
      if (e.shiftKey) return extendSelection(i);
      selectSection(i);
    });
    map.appendChild(b);
  });
}

function renderProgressSections() {
  const host = $('#progressSections');
  host.innerHTML = '';
  const D = engine.duration || 1;
  tl.sections.forEach((s, i) => {
    if (s.generic) return;
    const d = document.createElement('div');
    d.style.left = `${(s.start / D) * 100}%`;
    d.style.width = `${(Math.max(0, Math.min(D, s.end) - s.start) / D) * 100}%`;
    d.style.background = SECTION_COLORS[i % SECTION_COLORS.length];
    host.appendChild(d);
  });
}

function selectSection(i) {
  const s = tl.sections[i];
  loopSel = { startBar: s.startBar, endBar: s.endBar };
  applyLoop(engine.loop.enabled, true);
  engine.seek(tl.bars[s.startBar].start);
}

function extendSelection(i) {
  const s = tl.sections[i];
  if (!loopSel) loopSel = { startBar: s.startBar, endBar: s.endBar };
  else loopSel = { startBar: Math.min(loopSel.startBar, s.startBar), endBar: Math.max(loopSel.endBar, s.endBar) };
  applyLoop(true, true);
  toast(`Looping bars ${loopSel.startBar + 1}–${loopSel.endBar + 1}`);
}

function loopTimes() {
  if (!loopSel) return { a: 0, b: engine.duration };
  const a = Math.max(0, tl.bars[loopSel.startBar].start);
  const b = Math.min(engine.duration, tl.bars[loopSel.endBar].end);
  return { a, b };
}

function applyLoop(enabled, save = true) {
  const { a, b } = loopTimes();
  engine.setLoop(enabled, a, b);
  setPressed($('#btnLoop'), engine.loop.enabled);
  updateLoopLabel();
  showLoopOnTab();
  if (save && song) {
    prefs().loop = { enabled: engine.loop.enabled, startBar: loopSel?.startBar ?? null, endBar: loopSel?.endBar ?? null };
    saveSongSoon();
  }
}

function updateLoopLabel() {
  const el = $('#loopLabel');
  let txt;
  if (!loopSel) txt = 'Whole song';
  else {
    const sec = tl.sections.find(s => s.startBar === loopSel.startBar && s.endBar === loopSel.endBar);
    txt = `${sec ? sec.name + ' · ' : ''}bars ${loopSel.startBar + 1}–${loopSel.endBar + 1}`;
  }
  el.textContent = `${engine.loop.enabled ? 'Looping' : 'Selected'}: ${txt}`;
  const pl = $('#progressLoop');
  if (loopSel || engine.loop.enabled) {
    const { a, b } = loopTimes();
    const D = engine.duration || 1;
    pl.hidden = false;
    pl.style.left = `${(a / D) * 100}%`;
    pl.style.width = `${((b - a) / D) * 100}%`;
    pl.style.opacity = engine.loop.enabled ? 1 : 0.45;
  } else pl.hidden = true;
  document.querySelectorAll('.sec-chip').forEach((c, i) => {
    const s = tl.sections[i];
    c.classList.toggle('in-loop', !!loopSel && s.startBar >= loopSel.startBar && s.endBar <= loopSel.endBar);
  });
}

function showLoopOnTab() {
  if (!tl || !barDefs) return;
  if (!loopSel) { tab.showLoop(null); return; }
  tab.showLoop(tl.bars[loopSel.startBar].masterIndex, tl.bars[loopSel.endBar].masterIndex);
}

// ---------------- transport controls ----------------

function setPressed(el, on) { el.setAttribute('aria-pressed', on ? 'true' : 'false'); el.classList.toggle('on', on); }

$('#btnPlay').addEventListener('click', () => togglePlay());
async function togglePlay() {
  if (!song) return openSheet('#library');
  if (engine.playing) engine.pause();
  else {
    const bpb = tl?.bars[tl.barAt(engine.position)]?.beats || 4;
    await engine.play({ countInBeats: countIn ? Math.round(bpb) : 0 });
  }
}
engine.addEventListener('state', () => {
  $('#icoPlay').hidden = engine.playing;
  $('#icoPause').hidden = !engine.playing;
  $('#btnPlay').setAttribute('aria-label', engine.playing ? 'Pause' : 'Play');
});

function currentBar() { return tl ? tl.barAt(engine.position) : 0; }
function seekBar(i) {
  if (!tl) return;
  i = Math.max(0, Math.min(tl.bars.length - 1, i));
  engine.seek(Math.max(0, tl.bars[i].start));
}
$('#btnPrevBar').addEventListener('click', () => {
  const i = currentBar();
  const b = tl.bars[i];
  // like a CD player: if we're well into the bar, go to its start first
  if (engine.position - b.start > 0.35 * (b.end - b.start)) seekBar(i); else seekBar(i - 1);
});
$('#btnNextBar').addEventListener('click', () => seekBar(currentBar() + 1));
$('#btnLoopStart').addEventListener('click', () => {
  if (loopSel) return engine.seek(loopTimes().a);
  const i = currentBar();
  const s = tl.sections[tl.sectionAt(i)];
  const atStart = engine.position - s.start < 1.0;
  const target = atStart && tl.sectionAt(i) > 0 ? tl.sections[tl.sectionAt(i) - 1] : s;
  engine.seek(Math.max(0, target.start));
});
$('#btnLoop').addEventListener('click', () => applyLoop(!engine.loop.enabled));
$('#btnA').addEventListener('click', () => {
  if (!tl) return;
  const i = currentBar();
  const end = loopSel && loopSel.endBar >= i ? loopSel.endBar : Math.min(tl.bars.length - 1, i + 3);
  loopSel = { startBar: i, endBar: end };
  applyLoop(true);
  toast(`Loop from bar ${i + 1}. Press B at the last bar you want.`);
});
$('#btnB').addEventListener('click', () => {
  if (!tl) return;
  const i = currentBar();
  const start = loopSel ? Math.min(loopSel.startBar, i) : Math.max(0, i - 3);
  loopSel = { startBar: start, endBar: Math.max(i, start) };
  applyLoop(true);
  engine.seek(tl.bars[loopSel.startBar].start);
});
$('#btnClick').addEventListener('click', () => {
  const on = !engine.clickEnabled;
  engine.setClick(on);
  setPressed($('#btnClick'), on);
  if (song) { prefs().click = on; saveSongSoon(); }
});
$('#btnCountIn').addEventListener('click', () => {
  countIn = !countIn;
  setPressed($('#btnCountIn'), countIn);
  if (song) { prefs().countIn = countIn; saveSongSoon(); }
});

function setTempo(v) {
  v = Math.max(50, Math.min(125, Math.round(v / 5) * 5));
  $('#tempo').value = v;
  engine.setRate(v / 100);
  updateTempoLabel();
  if (song) { prefs().rate = v; saveSongSoon(); }
}
function updateTempoLabel() {
  const v = +$('#tempo').value;
  $('#tempoLabel').textContent = `${v}%`;
}
$('#tempo').addEventListener('input', updateTempoLabel);
$('#tempo').addEventListener('change', (e) => setTempo(+e.target.value));
$('#btnSlower').addEventListener('click', () => setTempo(+$('#tempo').value - 5));
$('#btnFaster').addEventListener('click', () => setTempo(+$('#tempo').value + 5));

// progress bar scrubbing
(() => {
  const el = $('#progress');
  let dragging = false;
  const posFrom = (e) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * engine.duration;
  };
  el.addEventListener('pointerdown', (e) => { if (!song) return; dragging = true; el.setPointerCapture(e.pointerId); engine.seek(posFrom(e)); });
  el.addEventListener('pointermove', (e) => { if (dragging) { lastUi.scrub = posFrom(e); } });
  el.addEventListener('pointerup', (e) => { if (dragging) { dragging = false; engine.seek(posFrom(e)); lastUi.scrub = null; } });
})();

// keyboard (desktop)
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') $('#btnPrevBar').click();
  else if (e.key === 'ArrowRight') $('#btnNextBar').click();
  else if (e.key === 'l' || e.key === 'L') $('#btnLoop').click();
  else if (e.key === 'a' || e.key === 'A') $('#btnA').click();
  else if (e.key === 'b' || e.key === 'B') $('#btnB').click();
  else if (e.key === 'c' || e.key === 'C') $('#btnClick').click();
  else if (e.key === '-') $('#btnSlower').click();
  else if (e.key === '=' || e.key === '+') $('#btnFaster').click();
});

// ---------------- mixer ----------------

function renderMixer() {
  const list = $('#stemList');
  list.innerHTML = '';
  if (!song) { list.innerHTML = '<p class="hint">Load a song first.</p>'; return; }
  const anySolo = engine.stems.some(s => s.solo);
  engine.stems.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'stem';
    if (s.muted || (anySolo && !s.solo)) row.classList.add('silent');
    row.innerHTML = `
      <span class="stem-dot" style="background:${STEM_COLORS[i % STEM_COLORS.length]}"></span>
      <span class="stem-name"></span>
      <button class="ms m ${s.muted ? 'on' : ''}" title="Mute">M</button>
      <button class="ms s ${s.solo ? 'on' : ''}" title="Solo">S</button>
      <input type="range" min="0" max="1.5" step="0.01" value="${s.volume}" aria-label="${s.name} volume" />`;
    row.querySelector('.stem-name').textContent = s.name;
    row.querySelector('.m').addEventListener('click', () => { engine.setStem(s.id, { muted: !s.muted }); persistStem(s); renderMixer(); });
    row.querySelector('.s').addEventListener('click', () => { engine.setStem(s.id, { solo: !s.solo }); persistStem(s); renderMixer(); });
    row.querySelector('input').addEventListener('input', (e) => { engine.setStem(s.id, { volume: +e.target.value }); persistStem(s); });
    list.appendChild(row);
  });
}
function persistStem(s) {
  const p = prefs();
  p.stems ||= {};
  p.stems[s.id] = { volume: s.volume, muted: s.muted, solo: s.solo };
  saveSongSoon();
}
$('#clickVol').addEventListener('input', (e) => {
  engine.setClickVolume(+e.target.value);
  if (song) { prefs().clickVolume = +e.target.value; saveSongSoon(); }
});
$('#btnResetMix').addEventListener('click', () => {
  for (const s of engine.stems) { engine.setStem(s.id, { volume: 1, muted: false, solo: false }); persistStem(s); }
  renderMixer();
});

// ---------------- settings ----------------

function renderSettings() {
  $('#offsetVal').textContent = song ? song.sync.barOffset : 0;
  $('#nudgeVal').textContent = `${song ? song.sync.nudgeMs || 0 : 0} ms`;
  $('#bpbVal').textContent = song ? song.sync.beatsPerBar || 4 : 4;
  $('#bpbRow').hidden = !!barDefs;
  $('#zoomVal').textContent = `${Math.round(globalPrefs.scale * 100)}%`;
  document.querySelectorAll('[data-layout]').forEach(b => setPressed(b, b.dataset.layout === globalPrefs.layout));
  $('#optStereo').checked = !!globalPrefs.stereo;
}
document.querySelectorAll('[data-offset]').forEach(b => b.addEventListener('click', () => {
  if (!song) return;
  song.sync.barOffset = (song.sync.barOffset || 0) + +b.dataset.offset;
  resync();
}));
document.querySelectorAll('[data-nudge]').forEach(b => b.addEventListener('click', () => {
  if (!song) return;
  song.sync.nudgeMs = (song.sync.nudgeMs || 0) + +b.dataset.nudge;
  resync();
}));
document.querySelectorAll('[data-bpb]').forEach(b => b.addEventListener('click', () => {
  if (!song) return;
  song.sync.beatsPerBar = Math.max(1, Math.min(12, (song.sync.beatsPerBar || 4) + +b.dataset.bpb));
  resync();
}));
function resync() {
  const pos = engine.position;
  const keepLoop = engine.loop.enabled;
  rebuildTimeline();
  applyLoop(keepLoop);
  if (!engine.playing) engine.seek(pos);
  saveSongSoon();
  renderSettings();
}
document.querySelectorAll('[data-layout]').forEach(b => b.addEventListener('click', () => {
  globalPrefs.layout = b.dataset.layout;
  saveGlobalPrefs();
  tab.setLayout(globalPrefs.layout);
  renderSettings();
}));
document.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', () => {
  globalPrefs.scale = Math.max(0.6, Math.min(1.8, Math.round((globalPrefs.scale + +b.dataset.zoom) * 10) / 10));
  saveGlobalPrefs();
  tab.setLayout(null, globalPrefs.scale);
  renderSettings();
}));
$('#optStereo').addEventListener('change', (e) => {
  globalPrefs.stereo = e.target.checked;
  saveGlobalPrefs();
  if (song) { toast('Reloading the audio…'); closeSheets(); openSong(song.id); }
});

// ---------------- animation loop ----------------

function frame() {
  requestAnimationFrame(frame);
  if (!song || !tl) return;
  const pos = lastUi.scrub ?? engine.position;
  const D = engine.duration || 1;
  const i = tl.barAt(pos);
  const bar = tl.bars[i];
  const frac = tl.fracInBar(i, pos);

  const pct = `${(pos / D) * 100}%`;
  $('#progressFill').style.width = pct;
  $('#progressHead').style.left = pct;
  const tNow = fmt(pos);
  if (tNow !== lastUi.tNow) { $('#timeNow').textContent = tNow; lastUi.tNow = tNow; }
  const tTot = fmt(D);
  if (tTot !== lastUi.tTot) { $('#timeTotal').textContent = tTot; lastUi.tTot = tTot; }

  const beatNo = Math.min(Math.ceil(bar.beats), Math.floor(frac * bar.beats + 1e-6) + 1);
  const preRoll = pos < tl.bars[0].start - 0.02;
  const barTxt = preRoll ? 'Before bar 1' : `Bar ${i + 1}${barDefs && bar.number !== i + 1 ? ` (tab ${bar.number})` : ''} · beat ${beatNo}`;
  if (barTxt !== lastUi.barTxt) { $('#posBar').textContent = barTxt; lastUi.barTxt = barTxt; }
  const si = tl.sectionAt(i);
  if (si !== lastUi.si) {
    lastUi.si = si;
    const s = tl.sections[si];
    $('#posSection').textContent = s.generic ? '' : s.name;
    $('#bigSection').textContent = s.generic ? '' : s.name;
    document.querySelectorAll('.sec-chip').forEach((c, k) => c.classList.toggle('current', k === si));
    const chip = document.querySelectorAll('.sec-chip')[si];
    chip?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }

  const ci = engine.countInRemaining;
  const ciEl = $('#countIn');
  if (ci > 0) { ciEl.hidden = false; ciEl.textContent = `Count-in ${Math.ceil(ci / ((bar.end - bar.start) / bar.beats / engine.rate))}`; }
  else if (!ciEl.hidden) ciEl.hidden = true;

  if (barDefs) {
    if (!preRoll || engine.playing) tab.update(bar.masterIndex, preRoll ? 0 : frac, { follow: engine.playing || lastUi.mi !== bar.masterIndex });
    lastUi.mi = bar.masterIndex;
  } else {
    if (lastUi.big !== i || lastUi.beatNo !== beatNo) {
      $('#bigBar').textContent = preRoll ? '–' : i + 1;
      $('#bigBeat').textContent = preRoll ? '' : `/ ${tl.bars.length}`;
      const dots = $('#beatDots');
      const n = Math.ceil(bar.beats);
      if (dots.children.length !== n) dots.innerHTML = '<span></span>'.repeat(n);
      [...dots.children].forEach((d, k) => { d.classList.toggle('on', !preRoll && k === beatNo - 1); d.classList.toggle('down', k === 0); });
      lastUi.big = i; lastUi.beatNo = beatNo;
    }
  }
}
requestAnimationFrame(frame);

// ---------------- boot ----------------

(async function boot() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try {
    const songs = await lib.listSongs();
    const id = songs.find(s => s.id === globalPrefs.lastSong)?.id || songs[0]?.id;
    if (id) await openSong(id);
    else showWelcome(true);
  } catch (e) {
    console.error(e);
    showWelcome(true);
    toast('This browser blocked offline storage. Private browsing may be on.', 6000);
  }
})();

// expose for debugging / tests
window.__gpp = { engine, tab, get tl() { return tl; }, get song() { return song; }, openSong };
