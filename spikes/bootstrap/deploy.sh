#!/usr/bin/env bash
# Workers Builds deploy command (package.json "deploy"). Prints what the build image offers,
# optionally runs `modal deploy`, reports back to the Worker, and deploys with pywrangler.
set -euo pipefail

REPO="lugia19/comfyui-gen-mcp"
REF="${SPIKE_REF:-claude/upbeat-dijkstra-d03v19}"
START=$(date +%s)
since() { echo $(( $(date +%s) - START )); }

echo "== build image"
uname -srm
python3 --version; python3 -m pip --version; node --version
env | grep -E '^(CI|WORKERS_CI[A-Z_]*)=' || true
echo "vars present: SPIKE_CALLBACK=${SPIKE_CALLBACK:+yes} SPIKE_NONCE=${SPIKE_NONCE:+yes} MODAL_TOKEN_ID=${MODAL_TOKEN_ID:+yes}"

echo "== pip install uv modal"
python3 -m pip install --quiet --disable-pip-version-check uv modal \
  || python3 -m pip install --quiet --disable-pip-version-check --break-system-packages uv modal
# pywrangler shells out to `uv` on PATH; make sure that's the one just installed (it needs >= 0.12.3).
export PATH="$(python3 -c 'import os, uv; print(os.path.dirname(uv.find_uv_bin()))'):$PATH"
UV_VERSION=$(uv --version)
MODAL_VERSION=$(python3 -c 'import modal; print(modal.__version__)')
echo "$UV_VERSION, modal $MODAL_VERSION (t=$(since)s)"

echo "== fetch worker source ($REPO@$REF)"
rm -rf .src src vendor && mkdir -p .src vendor
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar xz -C .src --strip-components=1
cp -r .src/spikes/worker/src ./src
cp -r .src/spikes/sibling vendor/sibling
# The project file comes with the source, not with the template: Workers Builds runs `uv sync` on
# any pyproject.toml it finds before the deploy command, and this one needs vendor/ to exist.
cp .src/spikes/worker/button.pyproject.toml pyproject.toml

MODAL_RESULT="skipped (no MODAL_TOKEN_ID/MODAL_TOKEN_SECRET build secrets)"
if [ -n "${MODAL_TOKEN_ID:-}" ] && [ -n "${MODAL_TOKEN_SECRET:-}" ]; then
  echo "== modal deploy"
  T0=$(date +%s)
  if (cd .src/spikes/modal && python3 -m modal deploy spike_app.py); then
    MODAL_RESULT="ok in $(( $(date +%s) - T0 ))s"
  else
    MODAL_RESULT="FAILED after $(( $(date +%s) - T0 ))s"
  fi
fi
echo "modal: $MODAL_RESULT"

callback() {
  [ -n "${SPIKE_CALLBACK:-}" ] || { echo "no SPIKE_CALLBACK, skipping callback"; return 0; }
  STAGE="$1" UV_VERSION="$UV_VERSION" MODAL_VERSION="$MODAL_VERSION" MODAL_RESULT="$MODAL_RESULT" \
  ELAPSED="$(since)" python3 - <<'PY' || echo "callback FAILED (outbound network from the build?)"
import json, os, platform, urllib.request
body = {k: os.environ.get(v, "") for k, v in {
    "nonce": "SPIKE_NONCE", "stage": "STAGE", "uv": "UV_VERSION", "modal": "MODAL_VERSION",
    "modal_deploy": "MODAL_RESULT", "build_uuid": "WORKERS_CI_BUILD_UUID",
    "commit": "WORKERS_CI_COMMIT_SHA", "elapsed_s": "ELAPSED"}.items()}
body["python"] = platform.python_version()
# Cloudflare rejects urllib's default "Python-urllib/x.y" user agent with error 1010, even on
# workers.dev, before the request reaches the Worker. Any Python calling a Worker must set its own.
req = urllib.request.Request(os.environ["SPIKE_CALLBACK"], data=json.dumps(body).encode(),
                             headers={"Content-Type": "application/json",
                                      "User-Agent": "comfy-gen-build/0.1"}, method="POST")
print("callback:", urllib.request.urlopen(req, timeout=30).read().decode())
PY
}
callback before-deploy

echo "== pywrangler deploy"
uv run pywrangler deploy ${SPIKE_DEPLOY_ARGS:-}
echo "deployed (t=$(since)s)"
callback after-deploy
