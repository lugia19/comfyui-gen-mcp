"""A canned test image, built at import (deterministic, so it's fine in the startup snapshot).

Four solid quadrants, easy for a model to describe if it can actually see the image:
red top-left, green top-right, blue bottom-left, yellow bottom-right, with a white horizontal bar
across the middle.
"""

import struct
import zlib

W, H = 320, 240


def _png(width: int, height: int, pixel) -> bytes:
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # filter: none
        for x in range(width):
            rows.extend(pixel(x, y))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")


def _pixel(x: int, y: int) -> tuple[int, int, int]:
    if abs(y - H // 2) < 12:
        return (255, 255, 255)
    top, left = y < H // 2, x < W // 2
    if top and left:
        return (220, 30, 30)
    if top:
        return (30, 180, 60)
    if left:
        return (30, 60, 220)
    return (240, 210, 20)


PNG = _png(W, H, _pixel)
DESCRIPTION = (
    "red top-left, green top-right, blue bottom-left, yellow bottom-right, white horizontal bar"
)
