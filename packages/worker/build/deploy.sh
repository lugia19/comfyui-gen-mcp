#!/usr/bin/env bash
# The Workers Build step for a Comfy-Gen-MCP install.
#
# The user's repository (a copy of bootstrap/) runs this through its deploy command:
#   curl -fsSL "${COMFY_GEN_DEPLOY_URL:-.../releases/latest/download/deploy.sh}" | bash
# release.yml publishes it with the release's tag filled in below, so each release's script
# deploys that release's source. deploy.py does the rest; it ships with the source.
#
# Build variables it reads:
#   COMFY_GEN_REF         deploy this tag or branch instead (testing, pinning)
#   COMFY_GEN_DEPLOY_URL  read by the deploy command itself: where to get this script
#   COMFY_GEN_DEPLOY_ARGS extra wrangler deploy arguments (deploy.py), e.g. --dry-run
#   MODAL_TOKEN_ID/SECRET, COMFY_GEN_NONCE, COMFY_GEN_CALLBACK: set by the setup page (deploy.py)
set -euo pipefail

REPO="lugia19/comfyui-gen-mcp"
RELEASE_TAG="__COMFY_GEN_TAG__"  # filled in by release.yml
REF="${COMFY_GEN_REF:-$RELEASE_TAG}"
case "$REF" in
  __*__) echo "This deploy.sh is not from a release: set the COMFY_GEN_REF build variable to a tag or branch." >&2
         exit 1 ;;
esac

echo "== Comfy-Gen-MCP $REF"
python3 --version

# pywrangler shells out to the uv on PATH and needs a recent one; the build image's may be older.
python3 -m pip install --quiet --disable-pip-version-check uv \
  || python3 -m pip install --quiet --disable-pip-version-check --break-system-packages uv
export PATH="$(python3 -c 'import os, uv; print(os.path.dirname(uv.find_uv_bin()))'):$PATH"
uv --version

SRC=".comfy-gen/src"
rm -rf .comfy-gen && mkdir -p "$SRC"
curl -fsSL -A "comfy-gen-build" "https://codeload.github.com/$REPO/tar.gz/$REF" | tar xz -C "$SRC" --strip-components=1

exec python3 -u "$SRC/packages/worker/build/deploy.py" --template . --src "$SRC" --version "$REF"
