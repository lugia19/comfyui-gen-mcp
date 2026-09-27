# Infrastructure spikes

Throwaway tests that lock in the design before the product is built. Each spike below says what
to run and what to report. Results go into `docs/design.md` (section 12), then this folder is
deleted.

| Spike | Question | Where |
|---|---|---|
| S1 | CPU per `tools/call`: MCP SDK vs hand-rolled, against the 10 ms free budget | `worker/` |
| S2 | How claude.ai renders `resource_link` vs inline images, and what the model sees | `worker/` |
| S3 | Sandbox upload round trip (attached file → Worker) | `worker/` |
| S4 | Deploy button, Workers Builds driven from inside the Worker, `modal deploy` in a build | `bootstrap/` + `worker/` |
| S5 | Modal: Volume-backed input/output, cold starts, LoRA visibility, autoscaler | `modal/` |
| S6 | Durable Object WebSocket hibernation cost over a day | `worker/` + `agent_ws.py` |
| S7 | pywrangler vendors a uv workspace sibling | `worker/` + `sibling/` |
| S8 | How long a `tools/call` may block in each client | `worker/` (the `slow` tool) |

Everything is free except S5, which costs cents of Modal GPU time.

Already checked locally with `pywrangler dev` (2026-09-27): both MCP variants answer, the image
route, the upload round trip with the exact snippet the tool hands out, the sibling import (S7's
vendoring: the sibling lands in `python_modules/` as a real, non-editable install), and a relay
round trip through the Durable Object. `bootstrap/deploy.sh` also ran end to end as a dry run from
a standalone copy of the folder. Local wall time per `tools/call`: raw handler about 11 ms, SDK
about 45 ms (the SDK starts and stops its session manager on every request). That is wall time on
a dev machine, not Cloudflare CPU time, which is what S1 measures.

## Prerequisites

- A Cloudflare account (free plan), `node` 22+, and `uv` 0.12.3 or newer (`uv self update`).
- A Modal account with a card on file, and `pip install modal httpx websockets` locally.
- `modal token new` done once.

## A. Deploy the spike worker directly (S1, S2, S3, S6, S7, S8)

```sh
cd spikes/worker
uv sync
uv run pywrangler deploy                   # vendors deps, then wrangler deploy
uv run pywrangler secret put SPIKE_SECRET  # any long random string
uv run pywrangler secret put RELAY_SECRET  # another one
```

If the deploy complains that the KV namespace has no id, create it with
`npx wrangler kv namespace create SPIKE_KV` and put the id into `wrangler.jsonc`.

Open `https://comfy-gen-spike.<your-subdomain>.workers.dev/<SPIKE_SECRET>/`. It lists the two
connector URLs. Add both as custom connectors in claude.ai (Settings > Connectors > Add custom
connector) as "spike-sdk" and "spike-raw".

**S7.** Call the `sibling` tool once. Report its text.

**S1.** Call `ping` and `image_inline` about 10 times each through each connector (a mix of fresh
chats and repeated calls is fine). Then in the dashboard: Workers & Pages > comfy-gen-spike > Logs
(Workers Logs). Each invocation shows its CPU time; in the query builder, filter on the request URL
containing `/raw/mcp` or `/sdk/mcp` and look at `cpuTimeMs`. Report:

- CPU p50 / max for `tools/call` on raw and on SDK, and whether any request failed with Error 1102
  (exceeded CPU)
- CPU of the first request after a deploy (cold) vs later ones
- whether the claude.ai connector setup itself worked with each variant (initialize, tools/list)

**S2.** Turn the QoL extension off. In a new chat on each client (claude.ai web, Claude Desktop,
Claude mobile), with only one spike connector enabled, ask for each of the four tools in turn:
"Call image_link and describe the image in detail." The image is four colored quadrants (red
top-left, green top-right, blue bottom-left, yellow bottom-right) with a white bar across the
middle. Fill in:

| Tool | Web: shown to you? / model described it? | Desktop | Mobile |
|---|---|---|---|
| `image_link` | | | |
| `image_link_text` | | | |
| `image_inline` | | | |
| `image_both` | | | |

**S3.** In claude.ai web, with code execution on and network access allowing the workers.dev
domain (Settings > Capabilities: note which setting you needed), attach any image and ask: "Use
request_upload to upload the image I attached, then call show_upload with the id and describe it."
Report: did it work, which network setting it needed, the path the snippet printed ("uploading
..."), and whether it also works in a later message of the same chat without re-attaching.

**S8.** Ask the model to call `slow` with seconds = 120, then 200, then 280, on web, Desktop and
mobile. Report the longest that came back, and what happened on the first one that didn't.

**S6.** Leave the stand-in agent running for about 24 hours:

```sh
python spikes/agent_ws.py https://comfy-gen-spike.<you>.workers.dev <RELAY_SECRET>
```

While it runs, open `/<SPIKE_SECRET>/relay/call?path=/ping` a few times and note `round_trip_ms`.
After a day, read the Durable Object metrics (Workers & Pages > comfy-gen-spike > Durable Objects:
requests, duration / GB-s) and count the `relay-do-wake` log lines (each is the object waking from
hibernation). Report the day's duration in GB-s (the free allowance is 13,000 GB-s a day), request
count, wake count, and the agent's reconnect count from its output. If the duration is high, run a
second day with `--proto-ping 0 --app-ping 30` and report both.

## B. Deploy button (S4)

1. Open this link and follow the flow (it creates a repository in your GitHub account from the
   `bootstrap/` folder only, provisions KV and the Durable Object, asks for the two secrets, and
   deploys through Workers Builds):

   https://deploy.workers.cloudflare.com/?url=https://github.com/lugia19/comfyui-gen-mcp/tree/claude/upbeat-dijkstra-d03v19/spikes/bootstrap

2. Report: did the first build succeed, how long it took, and whether the new repository contains
   only the `bootstrap/` files. If the build failed, paste the log.
3. Create a **user** API token (My Profile > API Tokens) with *Workers Builds Configuration: Edit*
   and *Workers Scripts: Read*.
4. Open `https://comfy-gen-spike-button.<you>.workers.dev/<SPIKE_SECRET>/builds`, paste the
   token, and press the buttons in order: Discover, Write variables (optionally with a Modal token
   pair from `modal token new --no-verify` or the dashboard, to test `modal deploy` from the build),
   Start a build, then Show callbacks.
5. Report: the Discover output (did it find the account, tag, trigger), whether writing variables
   worked, whether the build started and its logs streamed into the page, the build's duration and
   outcome, the callbacks received (`before-deploy` and `after-deploy`, with the uv, modal, and
   `modal_deploy` fields), and the build minutes used (Workers & Pages > the worker > Builds).
6. Also call `sibling` through this worker's MCP URL (the path-dependency variant of S7).

## C. Modal (S5)

```sh
cd spikes/modal
modal deploy spike_app.py
python drive.py all            # ~5-8 minutes, includes one wait for scale-to-zero
SPIKE_RELOAD_S=10 modal deploy spike_app.py
python drive.py lora           # the warm-LoRA check again, with a reload loop in the server
```

`drive.py` prints a "results to paste back" block at the end of each run; paste both. Also report
the image build time from the first deploy, and anything in the server logs starting with
`[spike]` (`modal app logs comfy-gen-spike`), especially volume reload failures. Clean up with
`modal app stop comfy-gen-spike` and `modal volume delete comfy-gen-spike-vol`.

## Cleanup

Delete the two Workers (comfy-gen-spike, comfy-gen-spike-button), the repository the button
created, the API token, the claude.ai connectors, and the Modal app and volume.
