#!/usr/bin/env node

/**
 * Runs maak.io locally: the Worker on http://localhost:8787, the local sign-in provider on :8788,
 * and a rebuild of the editor on every change.
 *
 * Usage:
 *   node scripts/dev.mjs           # development, state kept in .wrangler/state
 *   node scripts/dev.mjs --test    # tests: fresh state in .wrangler/test, no rebuild
 */

import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

const test = process.argv.includes("--test");
const state = test ? ".wrangler/test" : ".wrangler/state";
if (test) rmSync(state, { recursive: true, force: true });

const bin = (name) => resolve("node_modules/.bin", name);
const migrate = spawnSync(bin("wrangler"), ["d1", "migrations", "apply", "maak", "--local", "--persist-to", state], {
  stdio: "inherit",
  env: { ...process.env, CI: "1" },
});
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const children = [
  spawn("node", ["scripts/dev-idp.mjs"], { stdio: "inherit" }),
  spawn(bin("wrangler"), ["dev", "--port", "8787", "--ip", "127.0.0.1", "--persist-to", state, "--show-interactive-dev-session=false"], {
    stdio: "inherit",
  }),
];
if (!test) children.push(spawn(bin("vite"), ["build", "--watch"], { stdio: "inherit" }));

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", stop);
