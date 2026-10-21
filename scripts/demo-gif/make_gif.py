"""Turns record.js frames into the README GIF (docs/demo.gif): crops the title bar, merges
identical frames, keeps the recorded timing sped up a little (long waits capped) and holds the last
frame. Needs Pillow. Usage: python make_gif.py <outDir of record.js> docs/demo.gif"""
import json
import sys

from PIL import Image, ImageChops

run, out = sys.argv[1], sys.argv[2]
TOP = 30  # custom title bar ("[Extension Development Host] …")
CAP_MS, LAST_MS, SPEED = 1000, 4000, 1.3

frames = json.load(open(f"{run}/frames.json"))
images, durations = [], []
for i, f in enumerate(frames):
    im = Image.open(f"{run}/frames/{f['file']}").convert("RGB")
    im = im.crop((0, TOP, im.width, im.height))
    nxt = frames[i + 1]["t"] if i + 1 < len(frames) else f["t"] + LAST_MS
    ms = nxt - f["t"]
    if images and ImageChops.difference(im, images[-1]).getbbox() is None:
        durations[-1] += ms
        continue
    images.append(im)
    durations.append(ms)
durations = [min(round(d / SPEED), CAP_MS) for d in durations[:-1]] + [LAST_MS]

# One shared palette (VS Code's dark theme has few colours), no dithering: smaller and crisper.
sample = Image.new("RGB", (images[0].width, images[0].height * 3))
for k, idx in enumerate([0, len(images) // 2, len(images) - 1]):
    sample.paste(images[idx], (0, images[0].height * k))
palette = sample.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
pal = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in images]
pal[0].save(out, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(f"{len(pal)} frames, {sum(durations) / 1000:.1f} s")
