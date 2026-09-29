"""Tray icon variants by state: the icon's colored square recolored, the white letter kept.
Run once after changing the icon: uv run --with pillow python make_tray_icons.py"""

import colorsys

from PIL import Image

STATES = {  # hue (0-1), value factor
    "yellow": (48 / 360, 1.0),  # stopped, starting
    "green": (140 / 360, 0.8),  # running
    "red": (2 / 360, 0.9),  # needs you: failed, not installed, a download failed
}
SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def recolor(img: Image.Image, hue: float, vf: float) -> Image.Image:
    img = img.convert("RGBA")
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if a and s > 0.25:  # the colored square; the letter is white
                nr, ng, nb = colorsys.hsv_to_rgb(hue, s, v * vf)
                px[x, y] = (round(nr * 255), round(ng * 255), round(nb * 255), a)
    return img


big = Image.open("tray.ico")
big.size = max(big.info.get("sizes", [big.size]))
big.load()
small = Image.open("tray.png")
for name, (hue, vf) in STATES.items():
    recolor(big, hue, vf).save(f"tray-{name}.ico", sizes=SIZES)
    recolor(small, hue, vf).save(f"tray-{name}.png")
