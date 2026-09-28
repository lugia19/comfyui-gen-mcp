import struct

import pytest

from comfy_gen_core import refs
from comfy_gen_core.comfyui import OutputImage
from comfy_gen_core.images import image_size, sniff_mime
from fake_comfy import png


def jpeg(w, h):
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x00" * 9
    sof = b"\xff\xc0" + struct.pack(">HBHH", 17, 8, h, w) + b"\x00" * 10
    return b"\xff\xd8" + app0 + sof


def webp_vp8x(w, h):
    return b"RIFF\x00\x00\x00\x00WEBPVP8X" + b"\x00" * 8 + (w - 1).to_bytes(3, "little") + (h - 1).to_bytes(3, "little")


def webp_vp8l(w, h):
    bits = (w - 1) | ((h - 1) << 14)
    return b"RIFF\x00\x00\x00\x00WEBPVP8L" + b"\x00" * 4 + b"\x2f" + bits.to_bytes(4, "little")


def test_sizes_from_headers():
    assert image_size(png(832, 1216)) == (832, 1216)
    assert image_size(jpeg(1024, 768)) == (1024, 768)
    assert image_size(webp_vp8x(1536, 640)) == (1536, 640)
    assert image_size(webp_vp8l(300, 200)) == (300, 200)
    assert image_size(b"GIF89a" + struct.pack("<HH", 64, 32)) == (64, 32)
    assert image_size(b"not an image") is None
    assert image_size(png(1, 1)[:20]) is None  # truncated


def test_sniff_mime():
    assert sniff_mime(png(1, 1)) == "image/png"
    assert sniff_mime(jpeg(1, 1)) == "image/jpeg"
    assert sniff_mime(webp_vp8x(1, 1)) == "image/webp"
    assert sniff_mime(b"hello") is None


KEY = b"k" * 32


def test_refs_round_trip_and_reject_tampering():
    img = OutputImage("comfy-gen_00001_.png", "sub", "output")
    ref = refs.sign(img, KEY)
    assert refs.verify(ref, KEY) == img
    with pytest.raises(refs.RefError):
        refs.verify(ref, b"other key" * 4)
    payload, mac = ref.split(".")
    forged = refs.sign(OutputImage("../../etc/passwd", "", "output"), b"attacker" * 4).split(".")[0]
    with pytest.raises(refs.RefError):
        refs.verify(f"{forged}.{mac}", KEY)
    with pytest.raises(refs.RefError):
        refs.verify("garbage", KEY)


def test_load_value():
    assert OutputImage("a.png", "", "output").load_value() == "a.png [output]"
    assert OutputImage("a.png", "sub", "input").load_value() == "sub/a.png"


def test_upload_tokens_expire():
    token = refs.mint_upload(KEY, now=1000, ttl_s=600)
    nonce = refs.check_upload(token, KEY, now=1500)
    assert nonce
    with pytest.raises(refs.RefError, match="expired"):
        refs.check_upload(token, KEY, now=1601)
    with pytest.raises(refs.RefError):
        refs.check_upload(token + "x", KEY, now=1500)
    assert refs.upload_filename(nonce, "image/jpeg").endswith(".jpg")
    assert "/" not in refs.upload_filename("../x", "image/png")
