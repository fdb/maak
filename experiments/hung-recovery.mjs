#!/usr/bin/env node

/**
 * Follow-up experiment: after a preview hangs, when can a new frame on the same site load?
 * The parent reloads (as a student would), waits, and adds a frame to a page that does not hang.
 *
 * Usage: CHANNEL=chrome node experiments/hung-recovery.mjs
 */

import { createServer } from "node:http";
import { chromium } from "@playwright/test";

const PORT = 8798;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  // OAC=1 sends Origin-Agent-Cluster on the child pages, which asks for a process per origin.
  const oac = process.env.OAC && req.headers.host.includes("sites.") ? { "Origin-Agent-Cluster": "?1" } : {};
  res.writeHead(200, { "Content-Type": "text/html", ...oac });
  if (url.pathname === "/hang") return res.end("<!doctype html><script>while (true) {}</script>");
  if (url.pathname === "/fine") return res.end("<!doctype html><p>fine</p><script>parent.postMessage('fine', '*')</script>");
  res.end(`<!doctype html><p>parent</p><script>
    addEventListener("message", (e) => (window.got = e.data));
    window.add = (src) => { const f = document.createElement("iframe"); f.src = src; document.body.append(f); };
  </script>`);
}).listen(PORT, "127.0.0.1");

const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP *.test 127.0.0.1"], channel: process.env.CHANNEL ?? "chromium" });
const child = `http://name.sites.localhost:${PORT}`;
const other = `http://other.sites.localhost:${PORT}`;

async function run(label, wait, fresh, how) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://maak.localhost:${PORT}/`);
  await page.evaluate((src) => window.add(src), `${child}/hang`);
  await new Promise((r) => setTimeout(r, 1500));
  if (how === "reload") await page.reload();
  else await page.evaluate(() => document.querySelector("iframe").remove());
  await new Promise((r) => setTimeout(r, wait));
  const start = Date.now();
  await page.evaluate((src) => window.add(src), `${fresh}/fine`);
  const ok = await page.waitForFunction(() => window.got === "fine", null, { timeout: 20_000 }).then(() => true, () => false);
  console.log(`${label}: ${ok ? `loads after ${Date.now() - start} ms` : "does not load within 20 s"}`);
  await context.close();
}

await run("reload parent, same host, at once", 0, child, "reload");
await run("reload parent, same host, 5 s later", 5000, child, "reload");
await run("remove frame, same host, at once", 0, child, "remove");
await run("reload parent, other host on the same site", 0, other, "reload");
await browser.close();
server.close();
process.exit(0);
