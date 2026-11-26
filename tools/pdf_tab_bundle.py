#!/usr/bin/env python3
"""Turn Songsterr-style PDF tabs into a tab bundle the app can follow along with.

    python tools/pdf_tab_bundle.py --out like-light-to-the-flies-tabs.zip \
        "Rhythm guitar 1=rhythm_guitar_1.pdf" "Rhythm guitar 2=rhythm_guitar_2.pdf" \
        "Lead guitar=lead_guitar.pdf"

For each PDF it renders the pages to images, then finds every bar from the small
bar numbers printed above each bar, plus the section names ("Verse 1-1") and
tempo marks ("= 106"). The app shows the pages and moves a cursor through the bars
in time with the recording. Add the .zip to a song with Songs -> Add tab.

Needs poppler (pdftotext, pdftoppm) and Pillow.
"""
import argparse
import io
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from PIL import Image

WORD_RE = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>')
PAGE_RE = re.compile(r'<page width="([\d.]+)" height="([\d.]+)">(.*?)</page>', re.S)


def words_by_page(pdf):
    html = subprocess.run(["pdftotext", "-bbox", str(pdf), "-"], capture_output=True, text=True, check=True).stdout
    pages = []
    for w, h, body in PAGE_RE.findall(html):
        ws = [dict(x0=float(a), y0=float(b), x1=float(c), y1=float(d), t=t.strip()) for a, b, c, d, t in WORD_RE.findall(body)]
        pages.append(dict(w=float(w), h=float(h), words=[x for x in ws if x["t"]]))
    return pages


def index_pdf(pdf):
    pages = words_by_page(pdf)
    # Bar numbers are the smallest numeric text on the page.
    heights = sorted(round(w["y1"] - w["y0"]) for p in pages for w in p["words"] if w["t"].isdigit())
    if not heights:
        sys.exit(f"{pdf}: no bar numbers found")
    num_h = heights[0]
    bars = {}
    labels = []
    for pi, p in enumerate(pages):
        nums = [w for w in p["words"] if w["t"].isdigit() and abs((w["y1"] - w["y0"]) - num_h) < num_h * 0.15]
        # group into systems (rows) by y
        rows = []
        for w in sorted(nums, key=lambda w: (round(w["y0"] / 50), w["x0"])):
            if rows and abs(rows[-1][0]["y0"] - w["y0"]) < num_h * 2:
                rows[-1].append(w)
            else:
                rows.append([w])
        right = p["w"] - min((r[0]["x0"] for r in rows), default=p["w"] * 0.02)
        for ri, row in enumerate(rows):
            row.sort(key=lambda w: w["x0"])
            y0 = row[0]["y0"]
            y1 = rows[ri + 1][0]["y0"] - num_h * 1.5 if ri + 1 < len(rows) else min(p["h"], y0 + num_h * 13)
            for k, w in enumerate(row):
                x1 = row[k + 1]["x0"] if k + 1 < len(row) else right
                bars[int(w["t"])] = dict(page=pi, x0=w["x0"] / p["w"], x1=x1 / p["w"], y0=y0 / p["h"], y1=y1 / p["h"])
        # Section names and tempo marks: larger text just above a row of bar numbers.
        line = sorted([w for w in p["words"] if (w["y1"] - w["y0"]) > num_h * 1.3 and (w["y1"] - w["y0"]) < num_h * 1.7],
                      key=lambda w: (round(w["y0"]), w["x0"]))
        merged = []
        for w in line:
            if merged and abs(merged[-1]["y0"] - w["y0"]) < 5 and w["x0"] - merged[-1]["x1"] < num_h * 0.8:
                merged[-1]["t"] += " " + w["t"]
                merged[-1]["x1"] = w["x1"]
            else:
                merged.append(dict(w))
        for m in merged:
            row = next((r for r in rows if 0 < r[0]["y0"] - m["y0"] < num_h * 6), None)
            if not row:
                continue
            bar = min(row, key=lambda w: abs(w["x0"] - m["x0"]))
            labels.append((int(bar["t"]), m["t"]))
    sections, tempos = {}, {}
    for n, t in labels:
        tm = re.match(r"^\\?=\s*(\d+(?:\.\d+)?)$", t)
        if tm:
            tempos[n] = float(tm.group(1))
        elif not re.match(r"^((P\.M\.?|[HPTSX]|let ring|Tuning.*|\d+)\s*)+$", t, re.I):
            sections.setdefault(n, t)
    return pages, bars, sections, tempos


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("parts", nargs="+", help='"Part name=file.pdf"')
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=1400, help="page image width in pixels")
    args = ap.parse_args()

    bundle = {"format": 1, "kind": "pdf-tab", "parts": []}
    files = {}
    for spec in args.parts:
        name, _, path = spec.partition("=")
        pdf = Path(path)
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        pages, bars, sections, tempos = index_pdf(pdf)
        with tempfile.TemporaryDirectory() as td:
            subprocess.run(["pdftoppm", "-png", "-scale-to-x", str(args.width), "-scale-to-y", "-1", str(pdf), f"{td}/p"], check=True)
            imgs = sorted(Path(td).glob("p-*.png"), key=lambda q: int(q.stem.split("-")[1]))
            page_files = []
            for i, img in enumerate(imgs):
                im = Image.open(img).convert("L")
                buf = io.BytesIO()
                im.save(buf, "WEBP", quality=70)
                fn = f"pdf/{slug}/page-{i + 1}.webp"
                files[fn] = buf.getvalue()
                page_files.append({"file": fn, "w": im.width, "h": im.height})
        n_bars = max(bars) if bars else 0
        missing = [n for n in range(1, n_bars + 1) if n not in bars]
        # Multi-bar rests are drawn as one box: share that box among the bars it stands for.
        n = 1
        while n <= n_bars:
            if n in bars and n + 1 <= n_bars and (n + 1) not in bars:
                run = 1
                while n + run <= n_bars and (n + run) not in bars:
                    run += 1
                box = bars[n]
                w = (box["x1"] - box["x0"]) / run
                for k in range(run):
                    bars[n + k] = dict(box, x0=box["x0"] + k * w, x1=box["x0"] + (k + 1) * w, rest=run > 1)
                n += run
            else:
                n += 1
        bundle["parts"].append({
            "name": name, "pages": page_files,
            "bars": [bars.get(n) for n in range(1, n_bars + 1)],
            "sections": {str(k): v for k, v in sorted(sections.items())},
            "tempos": {str(k): v for k, v in sorted(tempos.items())},
        })
        print(f"{name}: {len(page_files)} pages, {n_bars} bars"
              f"{f', {len(missing)} bars inside multi-bar rests' if missing else ''}; sections {len(sections)}; tempos {tempos}")
    with zipfile.ZipFile(args.out, "w", zipfile.ZIP_STORED) as z:
        z.writestr("tab.json", json.dumps(bundle))
        for fn, data in files.items():
            z.writestr(fn, data)
    print(f"\n{args.out}  ({Path(args.out).stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
