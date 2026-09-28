import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))  # for fake_comfy, also under Pyodide

from comfy_gen_core import comfyui  # noqa: E402
from fake_comfy import FakeComfy  # noqa: E402


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def comfy(monkeypatch):
    monkeypatch.setattr(comfyui, "COLD_START_POLL_S", 0)
    return FakeComfy()


@pytest.fixture
def client(comfy):
    return comfyui.ComfyUIClient(comfy, cold_start_s=5, poll_interval_s=0)
