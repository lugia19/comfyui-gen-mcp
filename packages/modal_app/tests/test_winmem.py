import logging
from collections import namedtuple
from types import SimpleNamespace

import pytest

from comfy_gen_modal.comfy_node import winmem

svmem = namedtuple("svmem", ("total", "available", "percent", "used", "free"))
GB = 1024**3


def fake_psutil(result=None):
    """psutil as winmem sees it: psutil.virtual_memory() looks up _psplatform's at each call."""
    calls = []

    def slow():  # GetPerformanceInfo's: 200 ms a call after a game leaked handles
        calls.append(1)
        return result or svmem(32 * GB, 20 * GB, 37.5, 12 * GB, 20 * GB)

    platform = SimpleNamespace(virtual_memory=slow)
    return SimpleNamespace(_psplatform=platform, virtual_memory=lambda: platform.virtual_memory(), __version__="7.2.2"), calls


def test_switches_to_global_memory_status_with_psutils_shape(caplog):
    psutil, calls = fake_psutil()
    caplog.set_level(logging.INFO)
    assert winmem.install(psutil, status=lambda: (32 * GB, 8 * GB), env={})
    calls.clear()
    got = psutil.virtual_memory()
    assert type(got) is svmem
    assert got == svmem(32 * GB, 8 * GB, 75.0, 24 * GB, 8 * GB)  # free is available, as psutil has it on Windows
    assert calls == []  # never psutil's own
    assert psutil._psplatform.virtual_memory.comfy_gen_original() == svmem(32 * GB, 20 * GB, 37.5, 12 * GB, 20 * GB)
    assert "reads GlobalMemoryStatusEx now" in caplog.text
    assert winmem.install(psutil, status=lambda: (32 * GB, 8 * GB), env={})  # twice: still one layer
    assert psutil._psplatform.virtual_memory.comfy_gen_original.__name__ == "slow"


def test_percent_rounds_as_psutil_does():
    psutil, _ = fake_psutil()
    winmem.install(psutil, status=lambda: (32 * GB, 21 * GB), env={})
    assert psutil.virtual_memory().percent == round(11 / 32 * 100, 1)


def test_falls_back_to_psutils_own_when_the_call_fails_later():
    psutil, calls = fake_psutil()
    answers = [(32 * GB, 8 * GB), None]
    winmem.install(psutil, status=lambda: answers.pop(0) if answers else None, env={})
    assert psutil.virtual_memory().available == 20 * GB and calls


@pytest.mark.parametrize("psutil_result, status, why", [
    (namedtuple("svmem", ("total", "available", "percent", "used", "free", "cached"))(32 * GB, 20 * GB, 37.5, 12 * GB, 20 * GB, 0), lambda: (32 * GB, 8 * GB), "shape"),
    (svmem(32 * GB, 20 * GB, 37.5, 12 * GB, 19 * GB), lambda: (32 * GB, 8 * GB), "free isn't available"),
    (None, lambda: None, "GlobalMemoryStatusEx failed"),
    (None, lambda: (16 * GB, 8 * GB), "totals disagree"),
])
def test_anything_unexpected_leaves_psutil_as_it_is(psutil_result, status, why, caplog):
    psutil, _ = fake_psutil(psutil_result)
    original = psutil._psplatform.virtual_memory
    assert not winmem.install(psutil, status=status, env={}), why
    assert psutil._psplatform.virtual_memory is original
    assert "could not switch psutil.virtual_memory()" in caplog.text


def test_a_psutil_without_a_platform_backend_is_left_alone(caplog):
    assert not winmem.install(SimpleNamespace(virtual_memory=lambda: None), status=lambda: (1, 1), env={})
    assert "could not switch" in caplog.text


@pytest.mark.parametrize("value", ["0", "false", "OFF", " no "])
def test_switched_off_by_the_environment(value):
    psutil, _ = fake_psutil()
    original = psutil._psplatform.virtual_memory
    assert not winmem.install(psutil, status=lambda: (32 * GB, 8 * GB), env={winmem.ENV: value})
    assert psutil._psplatform.virtual_memory is original


def test_the_real_psutil_has_what_winmem_replaces():
    # psutil.virtual_memory() reads _psplatform.virtual_memory at each call (6.x to 7.2.2): the
    # replacement reaches every caller only while that holds.
    psutil = pytest.importorskip("psutil")  # ComfyUI's dependency, not this package's

    assert callable(psutil._psplatform.virtual_memory)
    seen = []
    original = psutil._psplatform.virtual_memory
    psutil._psplatform.virtual_memory = lambda: seen.append(1) or original()
    try:
        psutil.virtual_memory()
    finally:
        psutil._psplatform.virtual_memory = original
    assert seen == [1]
