"""The build-time deploy script (packages/worker/deploy/deploy.py) and the bootstrap template."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[3]
WORKER = ROOT / "packages" / "worker"

_spec = importlib.util.spec_from_file_location("deploy", WORKER / "deploy" / "deploy.py")
deploy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(deploy)


def test_jsonc_comments_and_trailing_commas():
    text = """
    // leading comment
    {
      "url": "https://example.com/a//b", /* block
      comment */ "glob": "/*not a comment*/",
      "quote": "say \\"hi\\" // still a string",
      "list": [1, 2, ],
      "obj": { "a": 1, },
    }
    """
    assert deploy.read_jsonc(text) == {
        "url": "https://example.com/a//b",
        "glob": "/*not a comment*/",
        "quote": 'say "hi" // still a string',
        "list": [1, 2],
        "obj": {"a": 1},
    }


def test_template_bindings_match_the_release():
    # The template's bindings are what the button provisions; the release's are what gets deployed.
    template = deploy.read_jsonc((ROOT / "bootstrap" / "wrangler.jsonc").read_text())
    release = deploy.read_jsonc((WORKER / "wrangler.jsonc").read_text())
    for key in ("main", "compatibility_date", "durable_objects", "migrations", "triggers"):
        assert template[key] == release[key], key
    assert template["name"] not in ("comfy-gen-mcp", "comfy-dxt")  # CLAUDE.md hard rule


def test_merge_takes_identity_from_the_template_and_the_rest_from_the_release():
    release = {
        "$schema": "x", "name": "comfy-gen", "main": "src/index.ts", "compatibility_date": "2027-01-01",
        "vars": {"VERSION": "dev", "OTHER": "1"},
        "assets": {"directory": "../../web/dist"},
    }
    template = {
        "name": "my-comfy", "compatibility_date": "2026-01-01", "workers_dev": False,
        "routes": [{"pattern": "comfy.example.com", "custom_domain": True}],
    }
    cfg = deploy.merge(release, template, "v1.2.3")
    assert cfg["name"] == "my-comfy"
    assert cfg["workers_dev"] is False and cfg["routes"] == template["routes"]
    assert cfg["compatibility_date"] == "2027-01-01"
    assert cfg["vars"] == {"VERSION": "v1.2.3", "OTHER": "1"}
    assert cfg["assets"] == {"directory": "../../web/dist"}
    assert "$schema" not in cfg


@pytest.fixture
def build(tmp_path, monkeypatch):
    """A build directory laid out as deploy.sh leaves it, with subprocess and urllib stubbed."""
    user = tmp_path / "repo"
    shutil.copytree(ROOT / "bootstrap", user)
    src = tmp_path / "src"
    (src / "packages" / "worker").mkdir(parents=True)
    shutil.copy(WORKER / "wrangler.jsonc", src / "packages" / "worker" / "wrangler.jsonc")

    b = SimpleNamespace(user=user, src=src, calls=[], posts=[], exit_code=0)

    def run(cmd, cwd=None, **kw):
        b.calls.append((cmd, cwd))
        if "comfy_gen_modal.deploy" in cmd:  # the Modal app's script
            out = Path(cmd[cmd.index("--out") + 1])
            out.write_text(json.dumps({"server_url": "https://m.modal.run", "admin_url": "https://a.modal.run"}))
        return subprocess.CompletedProcess(cmd, b.exit_code)

    class Resp:
        def read(self):
            return b'{"ok": true}'

    def urlopen(req, timeout):
        b.posts.append((req.full_url, req.get_header("User-agent"), json.loads(req.data)))
        return Resp()

    monkeypatch.setattr(deploy.subprocess, "run", run)
    monkeypatch.setattr(deploy.urllib.request, "urlopen", urlopen)
    for var in ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "COMFY_GEN_CALLBACK", "COMFY_GEN_NONCE"):
        monkeypatch.delenv(var, raising=False)

    def go():
        monkeypatch.setattr("sys.argv", ["deploy.py", "--template", str(user), "--src", str(src), "--version", "v1.0.0"])
        return deploy.main()

    b.go = go
    return b


def test_button_deploy_without_setup(build):
    assert build.go() == 0
    cfg = json.loads((build.src / "packages" / "worker" / "wrangler.jsonc").read_text())
    assert cfg["name"] == "comfy-gen" and cfg["vars"]["VERSION"] == "v1.0.0"
    assert cfg["assets"]["directory"] == "../../web/dist"
    assert build.calls == [
        (["npm", "ci", "--workspace", "packages/worker"], build.src),
        (["npx", "wrangler", "deploy"], build.src / "packages" / "worker"),
    ]
    assert build.posts == []  # no callback until the setup page starts a build


def test_setup_build_deploys_modal_and_reports(build, monkeypatch):
    monkeypatch.setenv("MODAL_TOKEN_ID", "ak-1")
    monkeypatch.setenv("MODAL_TOKEN_SECRET", "as-1")
    monkeypatch.setenv("COMFY_GEN_CALLBACK", "https://comfy-gen.x.workers.dev/build-callback")
    monkeypatch.setenv("COMFY_GEN_NONCE", "n0nce")

    assert build.go() == 0
    cmd, cwd = build.calls[0]
    assert cmd[:5] == ["uv", "run", "--package", "comfy-gen-modal", "--no-dev"] and cwd == build.src
    url, agent, body = build.posts[0]
    assert url.endswith("/build-callback") and agent == "comfy-gen-build"
    assert body == {
        "nonce": "n0nce", "stage": "deployed", "version": "v1.0.0", "modal_result": "ok",
        "modal": {"server_url": "https://m.modal.run", "admin_url": "https://a.modal.run"},
    }


def test_failed_deploy_is_reported(build, monkeypatch):
    monkeypatch.setenv("COMFY_GEN_CALLBACK", "https://w/build-callback")
    monkeypatch.setenv("COMFY_GEN_NONCE", "n")
    build.exit_code = 1
    assert build.go() == 1
    assert build.posts[0][2]["stage"] == "failed"


def test_modal_failure_still_deploys_the_worker_and_says_so(build, monkeypatch):
    monkeypatch.setenv("MODAL_TOKEN_ID", "ak-1")
    monkeypatch.setenv("MODAL_TOKEN_SECRET", "as-1")
    monkeypatch.setenv("COMFY_GEN_CALLBACK", "https://w/build-callback")
    monkeypatch.setenv("COMFY_GEN_NONCE", "n")
    real_run = deploy.subprocess.run
    monkeypatch.setattr(deploy.subprocess, "run", lambda cmd, cwd=None, **kw: (
        subprocess.CompletedProcess(cmd, 1) if "comfy_gen_modal.deploy" in cmd else real_run(cmd, cwd=cwd, **kw)))
    assert build.go() == 0
    body = build.posts[0][2]
    assert body["stage"] == "deployed" and body["modal_result"] == "failed (exit 1)" and "modal" not in body


def test_callback_retries_once_on_a_server_error(build, monkeypatch):
    import urllib.error

    monkeypatch.setenv("COMFY_GEN_CALLBACK", "https://w/build-callback")
    monkeypatch.setenv("COMFY_GEN_NONCE", "n")
    monkeypatch.setattr(deploy.time, "sleep", lambda s: None)
    answers = [urllib.error.HTTPError("https://w/build-callback", 500, "reset", {}, None), None]

    def urlopen(req, timeout):
        answer = answers.pop(0)
        if answer:
            raise answer
        build.posts.append(json.loads(req.data))

        class Resp:
            def read(self):
                return b'{"ok": true}'
        return Resp()

    monkeypatch.setattr(deploy.urllib.request, "urlopen", urlopen)
    assert build.go() == 0
    assert answers == [] and build.posts[0]["stage"] == "deployed"
