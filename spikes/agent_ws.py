"""Spike S6: a stand-in agent holding a WebSocket to the spike worker's Durable Object.

Run it for a day on any machine, then read the Durable Object's usage in the Cloudflare dashboard
(Workers & Pages > comfy-gen-spike > Metrics / Durable Objects). While it runs, the worker's
/relay/call route sends a request through the DO to this agent and reports the round trip.

    pip install websockets
    python agent_ws.py https://comfy-gen-spike.<you>.workers.dev <RELAY_SECRET>
    python agent_ws.py ... --proto-ping 0 --app-ping 30   # variant: app-level pings only

--proto-ping  seconds between WebSocket protocol pings (the websockets library default is 20)
--app-ping    seconds between text "ping" messages, which the DO answers via
              setWebSocketAutoResponse without waking up (0 = off)
"""

import argparse
import asyncio
import json
import time

import websockets


async def app_pinger(ws, every: float) -> None:
    while True:
        await asyncio.sleep(every)
        await ws.send("ping")


async def session(url: str, secret: str, proto_ping: float, app_ping: float, stats: dict) -> None:
    headers = {"Authorization": f"Bearer {secret}"}
    async with websockets.connect(
        url, additional_headers=headers, ping_interval=proto_ping or None, ping_timeout=30,
    ) as ws:
        stats["connects"] += 1
        print(f"[{time.strftime('%H:%M:%S')}] connected (#{stats['connects']})", flush=True)
        pinger = asyncio.create_task(app_pinger(ws, app_ping)) if app_ping else None
        try:
            async for raw in ws:
                if raw == "pong":
                    stats["pongs"] += 1
                    continue
                msg = json.loads(raw)
                stats["requests"] += 1
                # A real agent would forward msg to local ComfyUI; the spike just answers.
                reply = {"id": msg.get("id"), "status": 200, "body": f"agent echo: {msg.get('path')}",
                         "agent_time": time.time()}
                await ws.send(json.dumps(reply))
                print(f"[{time.strftime('%H:%M:%S')}] answered request {msg.get('id')}", flush=True)
        finally:
            if pinger:
                pinger.cancel()


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("worker_url")
    ap.add_argument("secret")
    ap.add_argument("--proto-ping", type=float, default=20)
    ap.add_argument("--app-ping", type=float, default=0)
    args = ap.parse_args()
    url = args.worker_url.rstrip("/").replace("https://", "wss://").replace("http://", "ws://") + "/relay/connect"

    stats = {"connects": 0, "requests": 0, "pongs": 0}
    started = time.monotonic()
    backoff = 1.0
    while True:
        try:
            await session(url, args.secret, args.proto_ping, args.app_ping, stats)
            backoff = 1.0
        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] disconnected: {type(e).__name__}: {e}", flush=True)
        hours = (time.monotonic() - started) / 3600
        print(f"  up {hours:.2f}h, stats {stats}; reconnecting in {backoff:.0f}s", flush=True)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    asyncio.run(main())
