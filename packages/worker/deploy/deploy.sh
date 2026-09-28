#!/usr/bin/env bash
# The Workers Build step for a Comfy-Gen-MCP install.
#
# The user's repository (a copy of bootstrap/) runs this through its deploy command:
#   curl -fsSL "${COMFY_GEN_DEPLOY_URL:-.../releases/latest/download/deploy.sh}" | bash
# (COMFY_GEN_DEPLOY_URL, a build variable, points it elsewhere, e.g. at a branch's copy.)
# release.yml publishes it with the release's tag filled in below, so each release's script
# deploys that release's source. deploy.py does the rest; it ships with the source.
#
# COMFY_GEN_REF, a build variable, deploys another tag or branch instead (testing, pinning).
# Arguments go to deploy.py: `bash deploy.sh --dry-run` builds everything but deploys nothing.
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

# uv runs the Modal deploy (comfy_gen_modal.deploy); the build image may lack it or have an old one.
python3 -m pip install --quiet --disable-pip-version-check uv \
  || python3 -m pip install --quiet --disable-pip-version-check --break-system-packages uv
# By path, not by prepending its directory to PATH: that directory can hold an older node.
export UV="$(python3 -c 'import uv; print(uv.find_uv_bin())')"
"$UV" --version

SRC=".comfy-gen/src"
rm -rf .comfy-gen && mkdir -p "$SRC"
curl -fsSL -A "comfy-gen-build" "https://codeload.github.com/$REPO/tar.gz/$REF" | tar xz -C "$SRC" --strip-components=1

exec python3 -u "$SRC/packages/worker/deploy/deploy.py" --template . --src "$SRC" --version "$REF" "$@"
