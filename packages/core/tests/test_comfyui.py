import pytest

from comfy_gen_core.comfyui import ComfyUIClient, ComfyUIError, OutputImage

pytestmark = pytest.mark.anyio

WF = {"1": {"class_type": "SaveImage", "inputs": {}}}


async def test_submit_waits_out_a_cold_start(client, comfy):
    comfy.boot_503s = 3
    assert await client.submit(WF) == "p1"
    assert [c[1] for c in comfy.calls].count("/prompt") == 4


async def test_submit_without_cold_start_budget_fails_on_503(comfy):
    comfy.boot_503s = 1
    with pytest.raises(ComfyUIError, match="HTTP 503"):
        await ComfyUIClient(comfy).submit(WF)


async def test_rejection_names_the_bad_node(client, comfy):
    comfy.reject = {"error": {"message": "Prompt outputs failed validation"},
                    "node_errors": {"44": {"class_type": "UNETLoader",
                                           "errors": [{"message": "Value not in list", "details": "unet_name: x"}]}}}
    with pytest.raises(ComfyUIError, match=r"node 44 \(UNETLoader\): Value not in list"):
        await client.submit(WF)


async def test_wait_returns_output_images(client, comfy):
    await client.submit(WF)
    comfy.history = ["running", "running", "done"]
    assert await client.wait("p1", timeout=60) == [OutputImage("comfy-gen_00001_.png", "", "output")]


async def test_wait_times_out_with_none(client, comfy):
    await client.submit(WF)
    comfy.history = ["running"] * 50
    assert await client.wait("p1", timeout=0) is None


async def test_wait_reports_execution_errors(client, comfy):
    await client.submit(WF)
    comfy.history = ["error"]
    with pytest.raises(ComfyUIError, match="KSampler: out of memory"):
        await client.wait("p1", timeout=60)


async def test_wait_detects_a_replaced_worker(client, comfy):
    await client.submit(WF)
    comfy.history = ["running", 503, "gone", "gone"]
    with pytest.raises(ComfyUIError, match="restarted mid-image"):
        await client.wait("p1", timeout=60)


async def test_wait_on_an_unknown_id(client, comfy):
    comfy.history = ["gone", "gone"]
    with pytest.raises(ComfyUIError, match="Unknown or expired"):
        await client.wait("nope", timeout=60)


async def test_status_message(client, comfy):
    await client.submit(WF)
    comfy.history = ["pending"]
    await client.wait("p1", timeout=0)
    assert await client.status_message("p1") == "Position 2 in queue"


async def test_view_passes_the_preview_format(client, comfy):
    resp = await client.view(OutputImage("a.png"), preview="webp;90")
    assert resp.content.startswith(b"RIFF")
    assert comfy.calls[-1][2] == {"filename": "a.png", "subfolder": "", "type": "output", "preview": "webp;90"}


async def test_upload_sends_multipart_and_returns_an_input_image(client, comfy):
    img = await client.upload(b"\x89PNG data", "upload-x.png", "image/png", subfolder="comfy-gen-uploads")
    assert img == OutputImage("upload-x.png", "comfy-gen-uploads", "input")
    assert b"\x89PNG data" in comfy.uploads[0]


async def test_node_classes(client):
    assert "KSampler" in await client.node_classes()
