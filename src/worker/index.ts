// One Worker answers the editor, the preview and every shared site. The host name picks the role.

import { appFetch } from "./app";
import type { Env } from "./env";
import { cleanup } from "./projects";
import { serveSite } from "./sites";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const host = url.host.toLowerCase();
    if (host === env.APP_HOST) return appFetch(req, env, ctx);
    if (host === `www.${env.APP_HOST}`) {
      return Response.redirect(`${url.protocol}//${env.APP_HOST}${url.pathname}${url.search}`, 301);
    }
    const suffix = `.${env.SITE_SUFFIX}`;
    if (host.endsWith(suffix)) {
      const label = host.slice(0, -suffix.length);
      if (label && !label.includes(".")) return serveSite(req, env, label);
    }
    return new Response("Not found", { status: 404, headers: { "X-Content-Type-Options": "nosniff" } });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanup(env).then((done) => console.log("cleanup", JSON.stringify(done))));
  },
} satisfies ExportedHandler<Env>;
