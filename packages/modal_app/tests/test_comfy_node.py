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
