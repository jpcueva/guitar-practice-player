# Guitar Practice Player

A practice app for playing along with songs, in the spirit of Moises, with the guitar tab on screen. It runs in the browser, installs on an iPhone home screen, and works offline.

- **Stem mixer:** plays every stem (lead, rhythm, bass, drums, vocals, other) in sync, with mute, solo and volume.
- **Tempo:** 50–125% without changing the pitch.
- **Loops:** tap a section (Verse, Chorus, Solo…) to jump and select it, long-press another section to extend the selection, or set A/B at any bar.
- **Tab:** Guitar Pro or MusicXML tabs, with a cursor that follows the recording, a track picker, and page or one-line layout. Tap a bar to jump to it.
- **Click and count-in:** a metronome on the song's real beat grid, which follows its tempo changes.

## Using it on an iPhone

1. Open the app's GitHub Pages address in Safari, then **Share → Add to Home Screen**. Opening it from the home screen keeps your songs stored long-term.
2. Put song packages (`.zip`) in OneDrive, iCloud Drive or Files.
3. In the app: **☰ → Add song**, and pick the `.zip`. It's copied into the app, so after that it plays offline.
4. To add a tab later: **☰ → Add tab** next to the song, and pick the `.gp` / `.gp5` / `.gpx` / MusicXML file.

## Adding a song

Song audio comes from a Moises export ("HiFi" separation, with the **metronome** stem included). There are two ways to bring it in:

**A. Compressed package (best for phones).** This turns ~420 MB of WAVs into ~50 MB:

```bash
python tools/make_song_package.py "Like Light to the Flies-D minor-106bpm-441hz.zip" \
    --artist Trivium --tab "like-light-to-the-flies.gp" --out songs/
```

You need `ffmpeg` and `numpy` installed. The script converts each stem to AAC and turns the metronome stem into a beat grid.

**B. Direct import.** Pick the Moises `.zip`, or all its WAV files, in **Add song**. The app finds the beats from the metronome stem itself. This is fine on a computer, but heavy on a phone.

### Lining the tab up with the recording

The metronome stem gives the beat times, and the tab gives the bars and time signatures. If the cursor runs a beat or a bar ahead or behind, open **⚙ Sync & display** and move "Bar 1 starts on beat". Use "Fine tune" for small offsets. These settings are saved for each song.

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
| `js/importer.js` | Reads packages, Moises zips and loose files |
| `js/library.js` | Offline song storage (IndexedDB) |
| `js/app.js` | UI |
| `tools/make_song_package.py` | Builds compressed song packages |

**How tempo keeps the pitch:** every stem plays at the same `playbackRate` (they stay sample-locked), then the mixed signal goes through a [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) pitch shifter that undoes the pitch change. At 100% the shifter is bypassed.

To run it locally: `python -m http.server`, then open http://localhost:8000.

Deployment: `.github/workflows/pages.yml` publishes `main` to GitHub Pages. Turn it on once under **Settings → Pages → Source: GitHub Actions**.

Third-party libraries are listed in [`vendor/README.md`](vendor/README.md).
