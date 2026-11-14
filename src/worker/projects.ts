// Projects, files and snapshots. Bytes live in R2 by content hash, the index lives in D1.

import { generateName, parentOf } from "../shared/rules";
import { DAY, type Env, type FileRow, type Project, blobKey, randomHex, sha256 } from "./env";

const SNAPSHOT_EVERY = 10 * 60 * 1000;

export interface ManifestEntry {
  path: string;
  kind: "file" | "folder";
  hash: string;
  size: number;
}

function starter(lang: string): Record<string, string> {
  const nl = lang !== "en";
  return {
    "index.html": `<!doctype html>
<html lang="${nl ? "nl" : "en"}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${nl ? "Mijn website" : "My website"}</title>
    <link rel="stylesheet" href="style.css">
  </head>
  <body>
    <h1>${nl ? "Welkom op mijn website" : "Welcome to my website"}</h1>
    <p>${nl ? "Verander deze tekst." : "Change this text."}</p>
    <script src="script.js"></script>
  </body>
</html>
`,
    "style.css": "body {\n  font-family: sans-serif;\n}\n",
    "script.js": "",
  };
}

export async function nameTaken(env: Env, name: string, exceptProject = ""): Promise<boolean> {
  const hit = await env.DB.prepare(
    "SELECT 1 FROM projects WHERE name = ?1 UNION ALL SELECT 1 FROM old_names WHERE name = ?1 AND until > ?2 AND project_id <> ?3 LIMIT 1",
  )
    .bind(name, Date.now(), exceptProject)
    .first();
  return hit !== null;
}

async function freeName(env: Env): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const name = generateName();
    if (!(await nameTaken(env, name))) return name;
  }
  for (;;) {
    const name = `${generateName()}-${Math.floor(Math.random() * 9000) + 1000}`;
    if (!(await nameTaken(env, name))) return name;
  }
}

async function insertProject(env: Env, ownerId: string, copiedFrom: string | null): Promise<Project> {
  const now = Date.now();
  const project: Project = {
    id: `p_${randomHex(8)}`,
    owner_id: ownerId,
    name: await freeName(env),
    secret: randomHex(8),
    shared: 0,
    copied_from: copiedFrom,
    rev_seq: 1,
    snapshot_at: 0,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO projects (id, owner_id, name, secret, shared, copied_from, rev_seq, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?)",
  )
    .bind(project.id, ownerId, project.name, project.secret, copiedFrom, now, now)
    .run();
  return project;
}

export async function createProject(env: Env, ownerId: string, lang: string): Promise<Project> {
  const project = await insertProject(env, ownerId, null);
  const inserts: D1PreparedStatement[] = [];
  for (const [path, text] of Object.entries(starter(lang))) {
    const bytes = new TextEncoder().encode(text);
    const hash = await sha256(bytes);
    await env.FILES.put(blobKey(project.id, hash), bytes);
    inserts.push(
      env.DB.prepare(
        "INSERT INTO files (project_id, path, kind, hash, size, rev, updated_at) VALUES (?, ?, 'file', ?, ?, 1, ?)",
      ).bind(project.id, path, hash, bytes.length, project.created_at),
    );
  }
  await env.DB.batch(inserts);
  return project;
}

export async function listFiles(env: Env, projectId: string): Promise<FileRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT path, kind, hash, size, rev, updated_at FROM files WHERE project_id = ? ORDER BY path",
  )
    .bind(projectId)
    .all<FileRow>();
  return results;
}

/** Copies rows and R2 objects to a new project. Works on one item at a time to stay small in memory. */
export async function copyProject(env: Env, source: Project, ownerId: string): Promise<Project> {
  const project = await insertProject(env, ownerId, source.id);
  const files = await listFiles(env, source.id);
  const hashes = [...new Set(files.filter((f) => f.kind === "file").map((f) => f.hash))];
  for (let i = 0; i < hashes.length; i += 6) {
    await Promise.all(
      hashes.slice(i, i + 6).map(async (hash) => {
        const object = await env.FILES.get(blobKey(source.id, hash));
        if (object) await env.FILES.put(blobKey(project.id, hash), await object.arrayBuffer());
      }),
    );
  }
  const inserts = files.map((f) =>
    env.DB.prepare(
      "INSERT INTO files (project_id, path, kind, hash, size, rev, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
    ).bind(project.id, f.path, f.kind, f.hash, f.size, f.updated_at),
  );
  for (let i = 0; i < inserts.length; i += 50) await env.DB.batch(inserts.slice(i, i + 50));
  return project;
}

/** Returns the next revision number of a project and marks it as edited. */
export async function nextRev(env: Env, projectId: string): Promise<number> {
  const row = await env.DB.prepare(
    "UPDATE projects SET rev_seq = rev_seq + 1, updated_at = ? WHERE id = ? RETURNING rev_seq",
  )
    .bind(Date.now(), projectId)
    .first<{ rev_seq: number }>();
  return row!.rev_seq;
}

/**
 * Makes sure every folder above a path exists. Returns "parent-is-file" when a file is in the way.
 */
export async function ensureParents(env: Env, projectId: string, path: string): Promise<string | null> {
  const parents: string[] = [];
  for (let p = parentOf(path); p; p = parentOf(p)) parents.push(p);
  if (!parents.length) return null;
  const marks = parents.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT path, kind FROM files WHERE project_id = ? AND path IN (${marks})`,
  )
    .bind(projectId, ...parents)
    .all<{ path: string; kind: string }>();
  if (results.some((r) => r.kind === "file")) return "parent-is-file";
  const have = new Set(results.map((r) => r.path));
  const missing = parents.filter((p) => !have.has(p));
  if (missing.length) {
    const now = Date.now();
    await env.DB.batch(
      missing.map((p) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO files (project_id, path, kind, hash, size, rev, updated_at) VALUES (?, ?, 'folder', '', 0, 0, ?)",
        ).bind(projectId, p, now),
      ),
    );
  }
  return null;
}

function manifestOf(files: FileRow[]): string {
  const entries: ManifestEntry[] = files.map(({ path, kind, hash, size }) => ({ path, kind, hash, size }));
  return JSON.stringify(entries);
}

/**
 * Stores the current list of paths and hashes. A snapshot copies no bytes.
 * Skips the insert when nothing changed since the last snapshot.
 */
export async function takeSnapshot(env: Env, projectId: string): Promise<string | null> {
  const now = Date.now();
  const manifest = manifestOf(await listFiles(env, projectId));
  const last = await env.DB.prepare(
    "SELECT manifest FROM snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(projectId)
    .first<{ manifest: string }>();
  await env.DB.prepare("UPDATE projects SET snapshot_at = ? WHERE id = ?").bind(now, projectId).run();
  if (last?.manifest === manifest) return null;
  const id = randomHex(6);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO snapshots (id, project_id, created_at, manifest) VALUES (?, ?, ?, ?)").bind(
      id,
      projectId,
      now,
      manifest,
    ),
    // Keep everything from the last 24 hours, then the last snapshot of each day for 30 days.
    env.DB.prepare("DELETE FROM snapshots WHERE project_id = ? AND created_at < ?").bind(projectId, now - 30 * DAY),
    env.DB.prepare(
      `DELETE FROM snapshots WHERE project_id = ?1 AND created_at < ?2 AND id NOT IN (
         SELECT id FROM (
           SELECT id, MAX(created_at) FROM snapshots WHERE project_id = ?1
           GROUP BY date(created_at / 1000, 'unixepoch')
         )
       )`,
    ).bind(projectId, now - DAY),
  ]);
  return id;
}

/** Takes a snapshot when the last one is more than ten minutes old. Called before a save. */
export async function snapshotIfDue(env: Env, project: Project): Promise<void> {
  if (Date.now() - project.snapshot_at > SNAPSHOT_EVERY) await takeSnapshot(env, project.id);
}

export interface SnapshotInfo {
  id: string;
  created_at: number;
  /** Number of paths whose content differs from the files of this moment. */
  changed: number;
}

export async function listSnapshots(env: Env, projectId: string): Promise<SnapshotInfo[]> {
  const current = new Map((await listFiles(env, projectId)).map((f) => [f.path, f.hash]));
  const { results } = await env.DB.prepare(
    "SELECT id, created_at, manifest FROM snapshots WHERE project_id = ? ORDER BY created_at DESC",
  )
    .bind(projectId)
    .all<{ id: string; created_at: number; manifest: string }>();
  return results.map((row) => {
    const then = new Map((JSON.parse(row.manifest) as ManifestEntry[]).map((f) => [f.path, f.hash]));
    let changed = 0;
    for (const [path, hash] of then) if (current.get(path) !== hash) changed++;
    for (const path of current.keys()) if (!then.has(path)) changed++;
    return { id: row.id, created_at: row.created_at, changed };
  });
}

export async function readSnapshot(env: Env, projectId: string, id: string): Promise<ManifestEntry[] | null> {
  const row = await env.DB.prepare("SELECT manifest FROM snapshots WHERE project_id = ? AND id = ?")
    .bind(projectId, id)
    .first<{ manifest: string }>();
  return row ? (JSON.parse(row.manifest) as ManifestEntry[]) : null;
}

/** Brings a snapshot back. The current state is snapshotted first, so a restore can be undone. */
export async function restoreSnapshot(env: Env, projectId: string, id: string): Promise<boolean> {
  const manifest = await readSnapshot(env, projectId, id);
  if (!manifest) return false;
  await takeSnapshot(env, projectId);
  const rev = await nextRev(env, projectId);
  const now = Date.now();
  const statements = [
    env.DB.prepare("DELETE FROM files WHERE project_id = ?").bind(projectId),
    ...manifest.map((f) =>
      env.DB.prepare(
        "INSERT INTO files (project_id, path, kind, hash, size, rev, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(projectId, f.path, f.kind, f.hash, f.size, f.kind === "file" ? rev : 0, now),
    ),
  ];
  // One batch is one transaction: the project never has half of two versions.
  await env.DB.batch(statements);
  return true;
}

/** Counts one event for a person in a time window and returns the new total. */
export async function count(env: Env, userId: string, kind: string, windowMs: number, amount = 1): Promise<number> {
  const now = Date.now();
  const bucket = `${kind}:${Math.floor(now / windowMs)}`;
  const row = await env.DB.prepare(
    "INSERT INTO counters (user_id, bucket, n, at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, bucket) DO UPDATE SET n = n + excluded.n RETURNING n",
  )
    .bind(userId, bucket, amount, now)
    .first<{ n: number }>();
  return row!.n;
}

/** The weekly job: empties old trash and deletes R2 objects that nothing refers to. */
export async function cleanup(env: Env): Promise<{ projects: number; objects: number }> {
  const now = Date.now();
  const { results: old } = await env.DB.prepare("SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?")
    .bind(now - 30 * DAY)
    .all<{ id: string }>();
  for (const { id } of old) await purgeProject(env, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM old_names WHERE until < ?").bind(now),
    env.DB.prepare("DELETE FROM counters WHERE at < ?").bind(now - 2 * DAY),
    env.DB.prepare("DELETE FROM invites WHERE expires_at < ?").bind(now),
  ]);

  let objects = 0;
  let cursor: string | undefined;
  const used = new Map<string, Set<string> | null>();
  do {
    const page = await env.FILES.list({ prefix: "projects/", cursor, limit: 500 });
    const doomed: string[] = [];
    for (const object of page.objects) {
      const [, projectId, hash] = object.key.split("/");
      if (!used.has(projectId)) used.set(projectId, await hashesInUse(env, projectId));
      const set = used.get(projectId);
      // A save writes the object before the row, so a fresh object may not have its row yet.
      if (now - object.uploaded.getTime() < DAY) continue;
      if (!set || !set.has(hash)) doomed.push(object.key);
    }
    if (doomed.length) await env.FILES.delete(doomed);
    objects += doomed.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { projects: old.length, objects };
}

async function hashesInUse(env: Env, projectId: string): Promise<Set<string> | null> {
  const project = await env.DB.prepare("SELECT 1 FROM projects WHERE id = ?").bind(projectId).first();
  if (!project) return null;
  const set = new Set<string>();
  for (const f of await listFiles(env, projectId)) if (f.hash) set.add(f.hash);
  const { results } = await env.DB.prepare("SELECT manifest FROM snapshots WHERE project_id = ?")
    .bind(projectId)
    .all<{ manifest: string }>();
  for (const row of results) {
    for (const f of JSON.parse(row.manifest) as ManifestEntry[]) if (f.hash) set.add(f.hash);
  }
  return set;
}

/** Removes the rows of a project. Its R2 objects go with the next weekly job. */
export async function purgeProject(env: Env, projectId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM files WHERE project_id = ?").bind(projectId),
    env.DB.prepare("DELETE FROM snapshots WHERE project_id = ?").bind(projectId),
    env.DB.prepare("DELETE FROM old_names WHERE project_id = ?").bind(projectId),
    env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId),
  ]);
}
