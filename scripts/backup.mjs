#!/usr/bin/env node

/**
 * Copies production to this computer: the whole database as SQL, and every stored file that the
 * database still points at (current files and history snapshots).
 *
 * Usage: node scripts/backup.mjs [folder]      (default ~/Backups/maak)
 *
 *   <folder>/<date>/maak.sql     the database, one per run
 *   <folder>/<date>/blobs.txt    the R2 keys that database needs
 *   <folder>/blobs/<key>         the files, shared by all runs; only new ones are fetched
 *
 * Files are stored under their SHA-256, so a fetched file is checked against its own name.
 * The backup holds students' email addresses and work: keep the folder on an encrypted disk.
 * D1 answers no other request while the export runs, which takes seconds at this size.
 * Restore it with scripts/restore.mjs.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

const root = resolve(process.argv[2] ?? join(homedir(), "Backups", "maak"));
const stamp = new Date().toISOString().slice(0, 16).replace(":", "");
const run = join(root, stamp);
mkdirSync(run, { recursive: true });

const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: "5fc69033e96d15e0db981519f3c4b372", CI: "1" };
const wrangler = (...args) => execFileSync(resolve("node_modules/.bin/wrangler"), args, { env, encoding: "utf8", maxBuffer: 1 << 28 });

console.log(`database -> ${run}/maak.sql`);
wrangler("d1", "export", "maak", "--env", "production", "--remote", "--skip-confirmation", "--output", join(run, "maak.sql"));

const query = `
  SELECT DISTINCT project_id AS p, hash AS h FROM files WHERE kind = 'file'
  UNION
  SELECT DISTINCT s.project_id, json_extract(j.value, '$.hash')
  FROM snapshots s, json_each(s.manifest) j WHERE json_extract(j.value, '$.kind') = 'file'`;
const out = JSON.parse(wrangler("d1", "execute", "maak", "--env", "production", "--remote", "--json", "--command", query));
const keys = out[0].results.map((r) => `projects/${r.p}/${r.h}`).sort();
writeFileSync(join(run, "blobs.txt"), keys.join("\n") + "\n");

let fetched = 0;
for (const key of keys) {
  const file = join(root, "blobs", key);
  if (existsSync(file)) continue;
  mkdirSync(dirname(file), { recursive: true });
  wrangler("r2", "object", "get", `maak-files/${key}`, "--remote", "--jurisdiction", "eu", "--file", `${file}.part`);
  const hash = createHash("sha256").update(readFileSync(`${file}.part`)).digest("hex");
  if (hash !== key.split("/")[2]) throw new Error(`${key} arrived with hash ${hash}`);
  renameSync(`${file}.part`, file);
  fetched++;
}
console.log(`${keys.length} files needed, ${fetched} fetched, ${keys.length - fetched} already here`);
