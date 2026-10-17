// Cloudflare Worker entry for the setup site: adapts the runtime to setup.ts (tested in Node).

import { handle, type Env } from "./setup.ts";

type Bound = Env & { ASSETS: Fetcher };

export default {
  fetch(req: Request, env: Bound): Promise<Response> {
    const host = new URL(req.url).host;
    return handle(req, env, {
      // A Worker can't fetch its own custom domain: the /dev bundles are read from its static files.
      fetch: (url, init) => (new URL(url).host === host ? env.ASSETS.fetch(new Request(url, init)) : fetch(url, init)),
      now: () => Date.now() / 1000,
      sleep: (s) => scheduler.wait(s * 1000),
    });
  },
} satisfies ExportedHandler<Bound>;
