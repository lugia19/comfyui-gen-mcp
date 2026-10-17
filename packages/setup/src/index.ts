// Cloudflare Worker entry for the setup site: adapts the runtime to setup.ts (tested in Node).

import { handle, type Env } from "./setup.ts";

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env, {
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now() / 1000,
      sleep: (s) => scheduler.wait(s * 1000),
    });
  },
} satisfies ExportedHandler<Env>;
