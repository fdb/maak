#!/usr/bin/env node

/**
 * Checks a running maak from the outside, without signing in.
 *
 * Usage:
 *   node scripts/smoke.mjs https://maak.io            # is it up and safe?
 *   node scripts/smoke.mjs https://maak.io <commit>   # also wait until this commit is live
 *
 * Exits 1 with the failed checks listed. The deploy workflow runs it after every deploy and rolls
 * back on failure; the uptime workflow runs it on a schedule.
 */

const [origin, commit] = process.argv.slice(2);
if (!origin) {
  console.error("usage: node scripts/smoke.mjs <origin> [commit]");
  process.exit(2);
}
const base = new URL(origin);
const failures = [];

async function check(name, run) {
  try {
    await run();
    console.log(`ok    ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const get = (path, init = {}) => fetch(new URL(path, base), { redirect: "manual", signal: AbortSignal.timeout(15_000), ...init });

await check(commit ? `version is ${commit}` : "version answers", async () => {
  // A new version reaches every Cloudflare location within seconds, not always at once.
  const until = Date.now() + 90_000;
  for (;;) {
    const res = await get("/api/version");
    expect(res.status === 200, `status ${res.status}`);
    const live = await res.json();
    if (!commit || live.commit === commit) return;
    if (Date.now() > until) throw new Error(`live commit is ${live.commit}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
});

let suffix = "";
await check("/api/me answers signed out", async () => {
  const res = await get("/api/me");
  expect(res.status === 200, `status ${res.status}`);
  const me = await res.json();
  expect(me.user === null, "a user without a cookie");
  expect(typeof me.siteSuffix === "string" && me.siteSuffix, "no siteSuffix");
  suffix = me.siteSuffix;
});

await check("the front page is the editor app with its security headers", async () => {
  const res = await get("/");
  expect(res.status === 200, `status ${res.status}`);
  expect((await res.text()).includes("<script"), "no script tag");
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp.includes("frame-ancestors 'none'"), "no CSP");
  expect(res.headers.get("x-content-type-options") === "nosniff", "no nosniff");
});

await check("the editor's script and style load", async () => {
  const html = await (await get("/")).text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  expect(assets.length > 0, "no assets in the page");
  for (const path of assets) {
    const res = await get(path);
    expect(res.status === 200, `${path}: status ${res.status}`);
  }
});

await check("sign-in goes to the provider with only openid, email and profile", async () => {
  const res = await get("/auth/login");
  expect(res.status === 302, `status ${res.status}`);
  const to = new URL(res.headers.get("location") ?? "", base);
  expect(to.host !== base.host, `stays on ${to.host}`);
  expect(to.searchParams.get("scope") === "openid email profile", `scope ${to.searchParams.get("scope")}`);
});

await check("a write without the editor's origin is refused", async () => {
  const res = await get("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  expect(res.status === 403, `status ${res.status}`);
});

// Node does not resolve <name>.localhost, so the site checks run against a real domain only.
if (base.protocol === "https:" && suffix) {
  await check("an unknown site answers 404 without being indexed", async () => {
    const label = `smoke-${Math.random().toString(36).slice(2, 10)}`;
    const res = await get(`https://${label}.${suffix}/`);
    expect(res.status === 404, `status ${res.status}`);
    expect(res.headers.get("x-robots-tag") === "noindex", "no noindex");
    expect(res.headers.get("origin-agent-cluster") === "?1", "no Origin-Agent-Cluster");
  });
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed on ${base.origin}`);
  process.exit(1);
}
console.log(`\nall checks passed on ${base.origin}`);
