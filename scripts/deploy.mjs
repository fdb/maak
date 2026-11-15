#!/usr/bin/env node

/**
 * Deploys to production: schema migrations, the Worker with its commit, then the smoke test.
 * If the smoke test fails, the Worker goes back to the version before. A migration is not undone,
 * so a migration must keep working with the code before it (add columns, do not rename them).
 *
 * Usage: npm test && node scripts/deploy.mjs
 * In CI, CLOUDFLARE_API_TOKEN must be set. Locally, wrangler uses your own login.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

const ORIGIN = "https://maak.io";
const ACCOUNT = "5fc69033e96d15e0db981519f3c4b372";
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CI: "1" };

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const dirty = git("status", "--porcelain") !== "";
const commit = git("rev-parse", "--short=12", "HEAD") + (dirty ? "-dirty" : "");

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const done = spawnSync(cmd, args, { stdio: "inherit", env });
  return done.status === 0;
}

const wrangler = resolve("node_modules/.bin/wrangler");
if (!run("npm", ["run", "build"])) process.exit(1);
if (!run(wrangler, ["d1", "migrations", "apply", "maak", "--env", "production", "--remote"])) process.exit(1);
if (!run(wrangler, ["deploy", "--env", "production", "--var", `COMMIT:${commit}`])) process.exit(1);
if (run("node", ["scripts/smoke.mjs", ORIGIN, commit])) process.exit(0);

console.log("\nThe smoke test failed. Rolling back to the version before.");
run(wrangler, ["rollback", "--env", "production", "--yes", "--message", `smoke test failed for ${commit}`]);
process.exit(1);
