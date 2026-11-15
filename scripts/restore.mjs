#!/usr/bin/env node

/**
 * Restores a backup from scripts/backup.mjs into a local state folder, for a rehearsal or to look
 * at old data. It never writes to production.
 *
 * Usage:
 *   node scripts/restore.mjs ~/Backups/maak/<date> [state]   (default state .wrangler/restore)
 *   node scripts/dev.mjs --state .wrangler/restore            then open a shared site locally
 *
 * To restore production itself: create a new D1 database, run the same `d1 execute --file` with
 * --remote against it, put the files back with `r2 object put --remote --jurisdiction eu`, and
 * point database_id in wrangler.jsonc at the new database. For a mistake within the last days,
 * D1 Time Travel is faster: wrangler d1 time-travel restore maak --env production --timestamp ...
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backup = process.argv[2] && resolve(process.argv[2]);
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const state = resolve(process.argv[3] ?? ".wrangler/restore");
if (!backup || !existsSync(join(backup, "maak.sql"))) {
  console.error("usage: node scripts/restore.mjs <backup folder with maak.sql> [state folder]");
  process.exit(2);
}

const wrangler = (...args) =>
  execFileSync(resolve("node_modules/.bin/wrangler"), args, { env: { ...process.env, CI: "1" }, stdio: ["ignore", "ignore", "inherit"] });

rmSync(state, { recursive: true, force: true });
console.log(`database -> ${state}`);
wrangler("d1", "execute", "maak", "--local", "--persist-to", state, "--yes", "--file", join(backup, "maak.sql"));

const keys = readFileSync(join(backup, "blobs.txt"), "utf8").split("\n").filter(Boolean);
const missing = [];
for (const key of keys) {
  const file = join(backup, "..", "blobs", key);
  if (!existsSync(file)) {
    missing.push(key);
    continue;
  }
  wrangler("r2", "object", "put", `maak-files/${key}`, "--local", "--persist-to", state, "--file", file);
}
console.log(`${keys.length - missing.length} of ${keys.length} files restored`);
if (missing.length) {
  console.error(`missing from the backup:\n${missing.join("\n")}`);
  process.exit(1);
}
