#!/usr/bin/env node

/**
 * Experiment from the spec: does a hung iframe freeze its parent page?
 * A parent page counts with a timer. Its iframe runs while (true) {}.
 * If the parent's counter keeps moving, the two run in different processes.
 *
 * Usage:
 *   node experiments/hung-iframe.mjs            # Chromium
 *   node experiments/hung-iframe.mjs firefox    # needs: npx playwright install firefox
 *   node experiments/hung-iframe.mjs webkit     # needs: npx playwright install webkit
 */

import { createServer } from "node:http";
import * as playwright from "@playwright/test";

const engine = process.argv[2] ?? "chromium";
const PORT = 8799;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  // OAC=1 sends Origin-Agent-Cluster on the child page, which asks for a process per origin.
  const oac = process.env.OAC && url.pathname === "/child" ? { "Origin-Agent-Cluster": "?1" } : {};
  res.writeHead(200, { "Content-Type": "text/html", ...oac });
  if (url.pathname === "/child") return res.end("<!doctype html><p>child</p><script>while (true) {}</script>");
  res.end(`<!doctype html><p id="n">0</p>
<script>let n = 0; setInterval(() => (document.getElementById("n").textContent = ++n), 50);</script>
<iframe src="${url.searchParams.get("child")}"></iframe>`);
}).listen(PORT, "127.0.0.1");

const cases = [
  ["same site: maak.test + name.maak.test", "maak.test", "name.maak.test"],
  ["two domains: maak.test + name.maaksites.test", "maak.test", "name.maaksites.test"],
  ["local dev: localhost + name.localhost", "localhost", "name.localhost"],
  // *.localhost is a secure context, which the Origin-Agent-Cluster header needs.
  ["same site, secure: maak.localhost + name.maak.localhost", "maak.localhost", "name.maak.localhost"],
];

// Chromium maps the test hosts to this machine. Other engines only run the localhost case.
const browser = await playwright[engine].launch(
  // CHANNEL=chrome uses the installed Chrome, CHANNEL=chromium the full Chromium build.
  // Without it, Playwright uses its headless shell.
  engine === "chromium" ? { args: ["--host-resolver-rules=MAP *.test 127.0.0.1"], channel: process.env.CHANNEL } : {},
);
for (const [label, parent, child] of cases) {
  if (engine !== "chromium" && !parent.endsWith("localhost")) continue;
  const page = await browser.newPage();
  const childUrl = encodeURIComponent(`http://${child}:${PORT}/child`);
  await page.goto(`http://${parent}:${PORT}/?child=${childUrl}`, { waitUntil: "commit" }).catch(() => null);
  await new Promise((r) => setTimeout(r, 1500));
  const read = () =>
    Promise.race([page.evaluate(() => Number(document.getElementById("n").textContent)), new Promise((r) => setTimeout(() => r(null), 2000))]);
  const first = await read();
  await new Promise((r) => setTimeout(r, 500));
  const second = first === null ? null : await read();
  const alive = second !== null && second > first;
  console.log(`${process.env.CHANNEL ?? engine} | ${label} | parent ${alive ? "keeps running" : "FREEZES"}`);
  await page.close({ runBeforeUnload: false }).catch(() => null);
}
await browser.close().catch(() => null);
server.close();
process.exit(0);
