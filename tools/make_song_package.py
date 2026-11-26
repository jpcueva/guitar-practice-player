#!/usr/bin/env python3
"""Build a phone-friendly song package from a Moises export.

    python tools/make_song_package.py "Like Light to the Flies-D minor-106bpm-441hz.zip" \
        --artist Trivium --tab "Like Light To The Flies.gp" --out songs/

Input is a Moises export: the .zip, or the folder of WAVs. Each stem is converted to
FLAC by default: lossless (sounds exactly like the WAV) at roughly half the size.
--codec aac makes AAC .m4a instead (much smaller, slightly lossy).
The "metronome" stem is not kept as audio: its clicks become the beat grid in
song.json, and the app plays its own click on that grid.

Output: <out>/<song-id>.zip holding song.json, stems/*.flac (or *.m4a) and the tab (if given).
Import it in the app with Songs -> Add song.

Needs: ffmpeg on PATH, numpy.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import wave
import zipfile
from pathlib import Path

import numpy as np

STEM_NAMES = {
    "vocals": "Vocals", "backing_vocals": "Backing vocals", "drums": "Drums", "bass": "Bass",
    "lead": "Lead guitar", "rhythm": "Rhythm guitar", "guitar": "Guitar", "other": "Other",
    "piano": "Piano", "keys": "Keys", "strings": "Strings", "wind": "Wind", "synth": "Synth",
    "acoustic": "Acoustic guitar", "electric": "Electric guitar",
}
STEM_ORDER = ["lead", "rhythm", "guitar", "acoustic", "electric", "bass", "drums", "vocals",
              "backing_vocals", "keys", "piano", "synth", "strings", "wind", "other"]
NAME_RE = re.compile(r"^(.*)-([a-z_ ]+?)-([^-]+)-(\d+(?:\.\d+)?)bpm-(\d+)hz$", re.I)
AUDIO_EXT = {".wav", ".mp3", ".m4a", ".flac", ".aif", ".aiff", ".ogg"}


def slugify(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:60] or "song"


def read_wav_mono(path):
    with wave.open(str(path)) as w:
        sr, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    if sw == 2:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
    elif sw == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        x = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
        x = np.where(x >= 1 << 23, x - (1 << 24), x).astype(np.float32) / (1 << 23)
    elif sw == 4:
        x = np.frombuffer(raw, dtype="<i4").astype(np.float32) / (1 << 31)
    else:
        raise SystemExit(f"Unsupported WAV sample width in {path}")
    return np.abs(x.reshape(-1, ch)).max(axis=1), sr


def detect_beats(path, ref_bpm):
    """Same algorithm as js/beats.js."""
    if Path(path).suffix.lower() != ".wav":
        tmp = Path(tempfile.mkdtemp()) / "met.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(path), str(tmp)], check=True)
        path = tmp
    env, sr = read_wav_mono(path)
    hop = 32
    frames = env[: len(env) // hop * hop].reshape(-1, hop).max(axis=1)
    thr = frames.max() * 0.5
    clicks, last = [], -1e9
    for i in np.nonzero(frames > thr)[0]:
        t = i * hop / sr
        if t - last > 0.09:
            clicks.append(t)
            last = t
    if len(clicks) < 3:
        return clicks
    if not ref_bpm:
        ref_bpm = 60 / float(np.median(np.diff(clicks)))
    min_int = 60 / (ref_bpm * 1.6)
    out = [clicks[0]]
    for t in clicks[1:]:
        if t - out[-1] >= min_int * 0.92:
            out.append(t)
    return [round(float(t), 4) for t in out]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", help="Moises export .zip or folder of stems")
    ap.add_argument("--tab", help="Guitar Pro (.gp/.gp5/.gpx) or MusicXML file")
    ap.add_argument("--title")
    ap.add_argument("--artist", default="")
    ap.add_argument("--codec", choices=["flac", "aac"], default="flac",
                    help="flac = lossless, about half the WAV size (default); aac = small, slightly lossy")
    ap.add_argument("--bitrate", default="256k", help="AAC bitrate (only with --codec aac)")
    ap.add_argument("--out", default=".")
    args = ap.parse_args()

    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is required (https://ffmpeg.org).")

    work = Path(tempfile.mkdtemp(prefix="gpp-"))
    src = Path(args.source)
    if src.suffix.lower() == ".zip":
        with zipfile.ZipFile(src) as z:
            z.extractall(work / "in")
        folder = work / "in"
    else:
        folder = src
    files = sorted(p for p in folder.rglob("*") if p.suffix.lower() in AUDIO_EXT and "__MACOSX" not in p.parts)
    if not files:
        sys.exit("No audio files found.")

    parsed = []
    for p in files:
        m = NAME_RE.match(p.stem)
        parsed.append((p, m.group(2).lower().strip() if m else slugify(p.stem).replace("-", "_"), m))
    first = next((m for _, _, m in parsed if m), None)
    zm = re.match(r"^(.*)-([^-]+)-(\d+(?:\.\d+)?)bpm-(\d+)hz$", src.stem, re.I)
    title = args.title or (first.group(1).strip() if first else (zm.group(1) if zm else src.stem))
    bpm = float(first.group(4)) if first else (float(zm.group(3)) if zm else None)
    key = first.group(3) if first else (zm.group(2) if zm else None)
    song_id = slugify(title)

    pkg = work / "pkg"
    (pkg / "stems").mkdir(parents=True)
    meta = {
        "format": 1, "id": song_id, "title": title, "artist": args.artist, "key": key,
        "bpm": int(bpm) if bpm and bpm.is_integer() else bpm, "stems": [], "tab": None, "beats": [],
        "sync": {"barOffset": 0, "beatsPerBar": 4, "nudgeMs": 0}, "sections": [],
    }
    for p, stem, _ in parsed:
        if stem == "metronome" or "metronome" in p.stem.lower():
            print(f"beats   <- {p.name}")
            meta["beats"] = detect_beats(p, bpm)
            continue
        if args.codec == "flac":
            out = pkg / "stems" / f"{stem}.flac"
            enc = ["-c:a", "flac", "-compression_level", "8"]
        else:
            out = pkg / "stems" / f"{stem}.m4a"
            enc = ["-c:a", "aac", "-b:a", args.bitrate, "-movflags", "+faststart"]
        print(f"encode  {p.name} -> stems/{out.name}")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(p), "-vn", *enc, str(out)], check=True)
        meta["stems"].append({"id": stem, "name": STEM_NAMES.get(stem, stem.replace("_", " ").capitalize()),
                              "file": f"stems/{out.name}"})
    meta["stems"].sort(key=lambda s: STEM_ORDER.index(s["id"]) if s["id"] in STEM_ORDER else 99)
    if args.tab:
        t = Path(args.tab)
        shutil.copy(t, pkg / f"tab{t.suffix.lower()}")
        meta["tab"] = f"tab{t.suffix.lower()}"
    (pkg / "song.json").write_text(json.dumps(meta, indent=1))

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_zip = out_dir / f"{song_id}.zip"
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_STORED) as z:
        for f in sorted(pkg.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(pkg).as_posix())
    shutil.rmtree(work, ignore_errors=True)
    print(f"\n{out_zip}  ({out_zip.stat().st_size / 1e6:.1f} MB, {len(meta['stems'])} stems, {len(meta['beats'])} beats)")


if __name__ == "__main__":
    main()
