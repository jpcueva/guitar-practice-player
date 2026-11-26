# Guitar Practice Player

A practice app for playing along with songs, in the spirit of Moises, with the guitar tab on screen. It runs in the browser, installs on an iPhone home screen, and works offline.

- **Stem mixer:** plays every stem (lead, rhythm, bass, drums, vocals, other) in sync, with mute, solo and volume.
- **Tempo:** 50–125% without changing the pitch.
- **Loops:** tap a section (Verse, Chorus, Solo…) to jump and select it, long-press another section to extend the selection, or set A/B at any bar.
- **Sections:** taken from the tab's section marks. Songs whose tab has none get a built-in map (`js/known-sections.js`), and you can rename or add sections under **⚙ Settings → Sections**.
- **Tab:** Guitar Pro or MusicXML tabs, with a cursor that follows the recording, and page or one-line layout. Tap a bar to jump to it.
- **Several parts at once:** pick **Several parts…** in the part menu (or **⚙ Settings → Parts on screen**) to stack guitars and bass as one-line tabs that scroll together, in the order you choose. PDF tabs work too: in one-line layout each bar is cut out of the pages and lined up per part.
- **Per-song settings:** tempo, mixer, loop, click, sync, sections, parts, layout and size are saved for each song on that device. **⚙ Settings → Export settings** saves them all in one file (on an iPhone, Save to Files → Google Drive), and **Import settings** loads that file on another device.
- **Click and count-in:** a metronome on the song's real beat grid, which follows its tempo changes.

## Using it on an iPhone

1. Open the app's GitHub Pages address in Safari, then **Share → Add to Home Screen**. Opening it from the home screen keeps your songs stored long-term.
2. Put song packages (`.zip`) in OneDrive, iCloud Drive or Files.
3. In the app: **☰ → Add song**, and pick the `.zip`. It's copied into the app, so after that it plays offline.
4. To add a tab later: **☰ → Add tab** next to the song, and pick the `.gp` / `.gp5` / `.gpx` / MusicXML file.

## Adding a song

Song audio comes from a Moises export ("HiFi" separation, with the **metronome** stem included). There are two ways to bring it in:

**A. Song package (best for phones).** Stems are stored as lossless FLAC, which sounds exactly like the WAVs at about 40% of the size (a 5–6 minute song is about 130–150 MB). Add `--codec aac` for a much smaller, slightly lossy package (about 50 MB):

```bash
python tools/make_song_package.py "Like Light to the Flies-D minor-106bpm-441hz.zip" \
    --artist Trivium --tab "like-light-to-the-flies.gp" --out songs/
```

You need `ffmpeg` and `numpy` installed. The script converts each stem to FLAC (or AAC) and turns the metronome stem into a beat grid. Adding a package for a song that's already in the app replaces its audio, and keeps a tab you attached and your settings.

The app plays from decoded audio in memory, so FLAC and AAC use the same memory while playing. Stems are kept as 16-bit samples and played by an AudioWorklet, which halves memory compared with Web Audio buffers, so every device plays in stereo by default. If an iPhone runs out of memory while loading a song, the app notices on the next launch, switches **⚙ Settings → Keep stereo** off (mono) and says so.

**B. Direct import.** Pick the Moises `.zip`, or all its WAV files, in **Add song**. The app finds the beats from the metronome stem itself. This is fine on a computer, but heavy on a phone.

**PDF tabs (no Guitar Pro file).** Songsterr-style PDF exports can be turned into a tab bundle that the app follows along with. It shows your original pages and moves a cursor through each bar:

```bash
python tools/pdf_tab_bundle.py --out like-light-to-the-flies-tabs.zip \
    "Rhythm guitar 1=rhythm_guitar_1.pdf" "Lead guitar=lead_guitar.pdf"
```

The script reads the bar numbers, section names and tempo marks from the PDF. It needs poppler (`pdftotext`, `pdftoppm`) and Pillow. Add the `.zip` with **☰ → Add tab**.

### Lining the tab up with the recording

Lining up happens automatically. The app steps through the tab's beats using its tempo map, snapping each beat to the nearest click in the Moises metronome stem. This copes with the metronome clicking double-time or triplets in some sections. It then picks the bar 1 position that matches the most clicks. If the cursor still runs a beat or a bar off, open **⚙ Settings** and move "Bar 1 starts on beat", or use "Fine tune". These settings are saved for each song.

## Where things are stored

Song audio and tabs are copyrighted, so they **never go in this repository** (see `.gitignore`). They stay on your devices, in the browser's IndexedDB storage. The repo holds only the app's code.

## Code

Plain HTML, CSS and ES modules, with no build step.

| File | What it does |
|---|---|
| `js/engine.js` | Web Audio engine: synced stems, mute/solo/volume, pitch-safe tempo, looping, click track |
| `js/timeline.js` | Maps bars to times in the recording using the beat grid |
| `js/beats.js` | Finds the beats in a Moises metronome stem |
| `js/tab.js` | alphaTab rendering, cursor, repeat expansion, tap-to-seek |
| `js/pdftab.js` | Follow-along view for PDF tab bundles |
| `js/importer.js` | Reads packages, Moises zips and loose files |
| `js/library.js` | Offline song storage (IndexedDB) |
| `js/known-sections.js` | Section maps for tabs without section marks |
| `js/app.js` | UI |
| `tools/make_song_package.py` | Builds compressed song packages |
| `tools/pdf_tab_bundle.py` | Turns PDF tabs into a follow-along bundle |

**How tempo keeps the pitch:** every stem plays at the same `playbackRate` (they stay sample-locked), then the mixed signal goes through a [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) pitch shifter that undoes the pitch change. At 100% the shifter is bypassed.

To run it locally: `python -m http.server`, then open http://localhost:8000.

Deployment: `.github/workflows/pages.yml` publishes `main` to GitHub Pages. Turn it on once under **Settings → Pages → Source: GitHub Actions**.

Third-party libraries are listed in [`vendor/README.md`](vendor/README.md).
