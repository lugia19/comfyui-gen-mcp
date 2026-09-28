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
