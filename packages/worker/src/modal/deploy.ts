// Deploying the Modal app from a Modal Sandbox, for a Worker made by the setup site (design §6): no
// Workers Build to run `modal deploy`, so the Worker starts a Sandbox in the user's workspace that
// runs the real one. A stock Python image with uv; the release's source; the Modal token from a
// workspace Secret; and comfy_gen_modal.deploy posts its report to the Worker's /build-callback,
// so the result arrives with no page open (the daily update).

import { releases } from "@comfy-gen/core";
import type { ModalClient, ModalToken } from "./client.ts";

/** The app the setup Sandboxes run in (not the comfy-gen app they deploy). */
export const SETUP_APP = "comfy-gen-setup";
/** The workspace Secret holding the Modal token, for the Sandbox's `modal deploy`. */
export const TOKEN_SECRET = "comfy-gen-token";
const IMAGE = ["FROM python:3.12-slim", "RUN pip install --no-cache-dir uv"];
/** A first deploy builds ComfyUI's image: give it time. */
const SANDBOX_TIMEOUT_S = 1800;

/** Where *tag*'s source is: GitHub's tag tarball, or the development base's source.tar.gz. */
export function sourceUrl(base: string | undefined, tag: string): string {
  return base ? `${releases.trim(base)}/${tag}/source.tar.gz` : `https://codeload.github.com/${releases.REPO}/tar.gz/${tag}`;
}

/** The workspace Secret with *token*, which the Sandbox's `modal deploy` signs in with: its id.
 * Written at every deploy too, so it is the Worker's token even if the Secret was changed in Modal. */
export function putTokenSecret(c: ModalClient, token: ModalToken): Promise<string> {
  return c.secretPut(TOKEN_SECRET, { MODAL_TOKEN_ID: token.id, MODAL_TOKEN_SECRET: token.secret });
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The Sandbox's script: fetch and unpack the source (one top folder), deploy, report. */
export function deployScript(source: string, callback: string, nonce: string, tag: string): string {
  const fetch = "import io,sys,tarfile,urllib.request as u; r=u.urlopen(u.Request(sys.argv[1],headers={'User-Agent':'comfy-gen-modal'})); "
    + "tarfile.open(fileobj=io.BytesIO(r.read()),mode='r:gz').extractall('/src',filter='data')";
  return [
    "set -e",
    `python3 -c ${q(fetch)} ${q(source)}`,
    "cd /src/*/",
    `uv run --package comfy-gen-modal --no-dev python -m comfy_gen_modal.deploy --callback ${q(callback)} --nonce ${q(nonce)} --version ${q(tag)}`,
  ].join("\n");
}

/** Start the deploy: the token's Secret (kept current), the setup app and image, the Sandbox. Its
 * id. Throws GrpcError. */
export async function startDeploy(c: ModalClient, token: ModalToken, script: string): Promise<string> {
  const [secretId, [appId, imageId]] = await Promise.all([
    putTokenSecret(c, token),
    c.appId(SETUP_APP).then(async (appId) => [appId, await c.image(appId, IMAGE, 50)] as const),
  ]);
  return c.sandboxCreate(appId, { image_id: imageId, secret_ids: [secretId], entrypoint_args: ["bash", "-c", script], timeout_secs: SANDBOX_TIMEOUT_S });
}
