import asyncio

from comfy_gen_modal.comfy_node import job_state, wait_for


class FakeQueue:
    """ComfyUI's PromptQueue, as the extension reads it. steps: what each read sees."""

    def __init__(self, *steps):
        self.steps = list(steps)
        self.now = steps[0]

    def get_current_queue_volatile(self):
        if self.steps:
            self.now = self.steps.pop(0)
        running, pending, _ = self.now
        return running, pending

    def get_history(self, prompt_id=None):
        return self.now[2]


RUNNING = ([(5, "p1", {}, {}, [])], [], {})
PENDING = ([(5, "other", {}, {}, [])], [(9, "p1", {}, {}, []), (7, "x", {}, {}, [])], {})
DONE = ([], [], {"p1": {"prompt": [1, "p1", {"big": "workflow"}], "status": {"status_str": "success"}, "outputs": {"9": {"images": []}}}})
GONE = ([], [], {})


def test_states():
    assert job_state(FakeQueue(RUNNING), "p1") == {"state": "running"}
    assert job_state(FakeQueue(PENDING), "p1") == {"state": "pending", "position": 2}  # ordered by number
    assert job_state(FakeQueue(DONE), "p1") == {"state": "done", "status": {"status_str": "success"}, "outputs": {"9": {"images": []}}}
    assert job_state(FakeQueue(GONE), "p1") == {"state": "unknown"}


def test_wait_returns_when_done(monkeypatch):
    monkeypatch.setattr("comfy_gen_modal.comfy_node.CHECK_EVERY_S", 0)
    assert asyncio.run(wait_for(FakeQueue(PENDING, RUNNING, RUNNING, DONE), "p1", 30))["state"] == "done"


def test_wait_times_out_with_the_current_state():
    assert asyncio.run(wait_for(FakeQueue(RUNNING), "p1", 0)) == {"state": "running"}
    assert asyncio.run(wait_for(FakeQueue(RUNNING), "p1", -5)) == {"state": "running"}


def test_watch_parent_exits_when_the_parent_is_gone(capfd):
    from comfy_gen_modal.comfy_node import watch_parent

    answers = iter([True, True, False])
    exited = []
    watch_parent(123, alive=lambda pid: next(answers), every_s=0, exit=exited.append)
    assert exited == [0]
    # written to the file descriptor, past any wrapper around sys.stdout
    assert "parent process 123 is gone" in capfd.readouterr().out


def test_pid_alive():
    import os
    import subprocess
    import sys

    from comfy_gen_modal.comfy_node import pid_alive

    assert pid_alive(os.getpid())
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    assert not pid_alive(child.pid)


# ── Removing signatures and watermarks: the box arithmetic (the node itself needs ComfyUI) ──

from comfy_gen_modal.comfy_node import ComfyGenRemoveMarks, crop_box, hole_box, mark_sized, merge_boxes


def test_one_mark_found_twice_is_filled_once():
    # base Anima's Patreon link came back as two overlapping boxes
    assert merge_boxes([[2, 0, 373, 65], [1, 1, 356, 48]]) == [[1, 0, 373, 65]]
    assert merge_boxes([[0, 0, 10, 10], [10, 10, 20, 20], [100, 100, 110, 110]]) == [[0, 0, 20, 20], [100, 100, 110, 110]]
    assert merge_boxes([]) == []


def test_the_hole_grows_with_the_mark_and_reaches_a_near_edge():
    assert hole_box([500, 500, 540, 520], 1536, 1536) == [492, 492, 548, 528]  # small: 8 px
    assert hole_box([400, 400, 600, 450], 1536, 1536) == [376, 376, 624, 474]  # 12% of 200
    # banishment's corner signature: near the left and bottom edges, so it runs to them
    assert hole_box([6, 1420, 188, 1506], 1536, 1536) == [0, 1399, 209, 1536]


def test_the_crop_keeps_the_surroundings_inside_the_image():
    assert crop_box([492, 492, 548, 528], 1536, 1536) == [444, 444, 596, 576]  # at least 48 px around
    assert crop_box([0, 1399, 209, 1536], 1536, 1536) == [0, 1226, 382, 1536]


def test_the_node_never_fails_an_image():
    images = object()  # whatever ComfyUI hands it: without ComfyUI, removal fails and it passes through
    assert ComfyGenRemoveMarks().run(images) == (images,)


def test_only_mark_sized_boxes_count():
    # The largest real mark seen (a watermark) against the one false find, on a 1536 x 1536 image.
    assert mark_sized([2, 0, 373, 65], 1536, 1536)
    assert not mark_sized([263, 1119, 1361, 1536], 1536, 1536)


# ── Redrawing part of an image: the geometry here; the tensor parts where torch is installed ──

import pytest

from comfy_gen_modal.comfy_node import NO_FACE, grow, parse_box, sample_size


def test_a_box_is_fractions_of_the_image():
    assert parse_box("", 1536, 1024) is None  # the largest face
    assert parse_box("0.25, 0.5, 0.75, 1", 1536, 1024) == [384, 512, 1152, 1024]
    assert parse_box("-0.1,0,1.2,0.5", 100, 100) == [0, 0, 100, 50]  # clipped to the image
    with pytest.raises(ValueError):
        parse_box("0.5,0.5,0.4,0.6", 100, 100)
    with pytest.raises(ValueError):
        parse_box("0.1,0.2,0.3", 100, 100)


def test_the_box_grows_about_its_centre():
    assert grow([100, 100, 200, 300], 1.2) == pytest.approx([90, 80, 210, 320])


def test_the_image_is_sampled_at_its_size_in_steps_of_16():
    assert sample_size(1536, 1024, 2359296) == (1536, 1024)  # within budget
    assert sample_size(4000, 3000, 2359296) == (1776, 1328)  # over: scaled down
    assert sample_size(1530, 1021, 2359296) == (1536, 1024)
    assert sample_size(500, 400, 2359296) == (496, 400)  # never scaled up


def test_the_no_face_message_points_at_the_box():
    assert "box" in NO_FACE


def test_the_mask_is_soft_and_inside_its_box():
    torch = pytest.importorskip("torch")
    from comfy_gen_modal.comfy_node import shape_mask

    m = shape_mask(200, 300, [100, 50, 200, 150], ellipse=False)
    assert m.shape == (200, 300)
    assert m[100, 150] == pytest.approx(1)  # the centre
    assert float(m[:, :60].max()) < 0.01 and float(m[:30].max()) < 0.01  # well outside: untouched
    assert 0.2 < float(m[100, 100]) < 0.8  # the edge: soft
    e = shape_mask(200, 300, [100, 50, 200, 150], ellipse=True)
    assert float(e[55, 105]) < float(m[55, 105])  # an ellipse leaves the corners


def test_the_paste_changes_only_the_masked_pixels_and_keeps_the_size():
    torch = pytest.importorskip("torch")
    from comfy_gen_modal.comfy_node import redraw_paste, shape_mask

    original = torch.rand(1, 120, 160, 3)
    mask = shape_mask(120, 160, [60, 40, 100, 80], ellipse=True)
    region = {"mask": mask}
    out = redraw_paste(original, torch.zeros(1, 112, 160, 3), region)  # sampled in steps of 16
    assert out.shape == original.shape
    assert torch.equal(out[0][mask == 0], original[0][mask == 0])
    assert float(out[0, 60, 80].max()) < 0.01  # the centre: the redraw
    alpha = torch.zeros(1, 120, 160)
    alpha[0, :10] = 1  # transparent along the top
    rgba = redraw_paste(original, torch.zeros(1, 112, 160, 3), region, alpha)
    assert rgba.shape == (1, 120, 160, 4) and float(rgba[0, 5, 5, 3]) == 0 and float(rgba[0, 60, 80, 3]) == 1
    opaque = redraw_paste(original, torch.zeros(1, 112, 160, 3), region, torch.zeros(1, 64, 64))  # LoadImage without alpha
    assert opaque.shape[-1] == 3


def test_the_region_node_samples_the_image_with_its_mask():
    torch = pytest.importorskip("torch")
    from comfy_gen_modal.comfy_node import redraw_region

    image = torch.rand(1, 1024, 1536, 3)
    sample, mask, region = redraw_region(image, "0.322,0.718,0.423,0.864", 2359296)
    assert sample.shape == (1, 1024, 1536, 3) and mask.shape == (1, 1024, 1536)
    assert region["mask"].shape == (1024, 1536)
    assert float(region["mask"][800, 572]) == pytest.approx(1)  # the box's centre
    assert float(region["mask"][100, 100]) == 0
    sample, mask, region = redraw_region(image, "0.322,0.718,0.423,0.864", 786432)  # over budget: smaller
    assert sample.shape == (1, 720, 1088, 3) and region["mask"].shape == (1024, 1536)


def test_faces_come_from_the_detector_output_largest_first():
    torch = pytest.importorskip("torch")
    pytest.importorskip("torchvision")
    from comfy_gen_modal.comfy_node import face_boxes

    # columns: centre x, centre y, width, height, score (at the letterboxed size)
    out = torch.tensor([[100, 101, 400, 300], [100, 100, 300, 300], [40, 40, 120, 10], [40, 40, 120, 10], [0.9, 0.8, 0.7, 0.1]]).float()
    found = face_boxes(out, 0.5)  # one face twice: kept once
    assert [pytest.approx(b) for b in found] == [[680, 480, 920, 720], [160, 160, 240, 240]]
    assert face_boxes(out[:, 3:], 1.0) == []


def test_the_detector_finds_frenni():
    pytest.importorskip("onnxruntime")
    import os

    model = os.environ.get("FACE_MODEL")
    picture = os.environ.get("FACE_PICTURE")
    if not (model and picture):
        pytest.skip("FACE_MODEL and FACE_PICTURE name the detector and a sprite")
    import numpy as np
    import torch
    from PIL import Image

    import comfy_gen_modal.comfy_node as node
    import onnxruntime

    node._face_session[:] = [onnxruntime.InferenceSession(model, providers=["CPUExecutionProvider"])]
    image = torch.from_numpy(np.asarray(Image.open(picture).convert("RGB"), dtype=np.float32) / 255)
    assert node.largest_face(image) == pytest.approx([522, 183, 760, 405], abs=6)


# ── Cut-outs: the cleanup's steps on synthetic images (numpy and scipy, where installed) ──


def _sprite():
    """A grey square subject with a black 3 px outline and a 1 px light ring outside it, on a plain
    light-grey background; an enclosed background-coloured hole and an enclosed pink patch inside."""
    np = pytest.importorskip("numpy")
    rgb = np.full((60, 60, 3), 0.8, np.float32)
    rgb[10:50, 10:50] = 0.0  # outline
    rgb[13:47, 13:47] = 0.4  # body
    rgb[9, 9:51] = rgb[50, 9:51] = rgb[9:51, 9] = rgb[9:51, 50] = 0.9  # the light ring
    rgb[20:26, 20:26] = 0.8  # hole: background colour
    rgb[32:38, 32:38] = (1.0, 0.7, 0.7)  # pink: subject
    alpha = np.zeros((60, 60), np.float32)
    alpha[9:51, 9:51] = 0.3  # the ring kept a little
    alpha[10:50, 10:50] = 1.0  # the base model fills everything inside, hole included
    return rgb, alpha


def test_enclosed_background_is_cleared_and_coloured_patches_kept():
    pytest.importorskip("scipy")
    from comfy_gen_modal.comfy_node import background_colour, clear_gaps

    rgb, alpha = _sprite()
    second = alpha.copy()
    second[20:26, 20:26] = 0  # isnet clears the hole
    second[32:38, 32:38] = 0  # and, wrongly, the pink patch
    colour = background_colour(rgb, alpha)
    out = clear_gaps(rgb, alpha, second, colour)
    assert out[22, 22] == 0  # the hole: background
    assert out[34, 34] == 1  # pink: not the background's colour, kept


def test_the_cutout_drops_the_light_ring_and_cleans_edge_colours():
    pytest.importorskip("scipy")
    from comfy_gen_modal.comfy_node import SHRINK, cutout

    np = pytest.importorskip("numpy")
    rgb, alpha = _sprite()
    out_rgb, out_alpha = cutout(rgb, alpha)
    assert out_alpha[9, 30] == 0  # the ring: gone
    assert out_alpha[10 + SHRINK, 30] == 1 and out_alpha[10 + SHRINK - 1, 30] < 1  # opaque from SHRINK px further in
    soft = (out_alpha > 0) & (out_alpha < 1)
    assert not soft.any() or (np.abs(out_rgb[soft] - 0.8) > 0.05).all()  # no background left in edge colours


def test_a_busy_background_only_shrinks():
    pytest.importorskip("scipy")
    from comfy_gen_modal.comfy_node import background_colour, cutout

    np = pytest.importorskip("numpy")
    rgb, alpha = _sprite()
    rgb[alpha < 0.02] = np.random.default_rng(0).random((int((alpha < 0.02).sum()), 3))  # a scene, not a plain background
    assert background_colour(rgb, alpha) is None
    out_rgb, out_alpha = cutout(rgb, alpha)
    assert np.array_equal(out_rgb, rgb) and out_alpha[22, 22] == 1  # colours as they were; no gap clearing


def test_the_node_never_fails_without_isnet():
    torch = pytest.importorskip("torch")
    pytest.importorskip("scipy")
    from comfy_gen_modal.comfy_node import ComfyGenCutout

    rgb, alpha = _sprite()
    (out,) = ComfyGenCutout().run(torch.from_numpy(rgb)[None], torch.from_numpy(alpha)[None])
    assert out.shape == (1, 60, 60, 4)
