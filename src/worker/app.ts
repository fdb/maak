// Everything on the editor's own host: the API, sign-in, and the editor app from static assets.

import { type Context, Hono } from "hono";
import { LIMITS, contentType, nameError, pathError } from "../shared/rules";
import { callback, currentUser, login, logout } from "./auth";
import { DAY, type Env, type FileRow, type Project, type User, blobKey, randomHex, sha256 } from "./env";
import {
  copyProject,
  count,
  createProject,
  ensureParents,
  listFiles,
  listSnapshots,
  nameTaken,
  nextRev,
  purgeProject,
  restoreSnapshot,
  snapshotIfDue,
  takeSnapshot,
} from "./projects";

type Ctx = Context<{ Bindings: Env; Variables: { user: User | null } }>;

const RATE = {
  savesPerMinute: 240,
  uploadBytesPerDay: 1024 * 1024 * 1024,
  projectsPerDay: 30,
};

const app = new Hono<{ Bindings: Env; Variables: { user: User | null } }>();

const fail = (c: Ctx, status: 400 | 401 | 403 | 404 | 409 | 412 | 413 | 415 | 429, error: string, extra: object = {}) =>
  c.json({ error, ...extra }, status);

// A student site is same-site with the editor, so SameSite cookies do not stop it from posting here.
// Every write must come from the editor's own origin, with a content type that a form cannot send.
app.use("*", async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD") {
    const type = (c.req.header("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    if (c.req.header("Origin") !== new URL(c.req.url).origin) return fail(c, 403, "origin");
    if (type !== "application/json" && type !== "application/octet-stream") return fail(c, 403, "content-type");
  }
  await next();
});

app.get("/auth/login", (c) => login(c.req.raw, c.env));
app.get("/auth/callback", (c) => callback(c.req.raw, c.env));
app.post("/auth/logout", (c) => logout(c.req.raw, c.env));

app.use("/api/*", async (c, next) => {
  c.set("user", await currentUser(c.req.raw, c.env));
  await next();
});

function publicProject(p: Project, user: User | null) {
  const owner = user?.id === p.owner_id;
  return {
    id: p.id,
    name: p.name,
    shared: p.shared === 1,
    owner,
    secret: owner ? p.secret : undefined,
    copied_from: owner ? p.copied_from : undefined,
    created_at: p.created_at,
    updated_at: p.updated_at,
    deleted_at: p.deleted_at,
  };
}

/**
 * Finds a project by id or by name and checks access. A project that the person may not see
 * answers exactly like one that does not exist.
 */
async function find(c: Ctx, mode: "read" | "write", opts: { trashed?: boolean } = {}): Promise<Project | null> {
  const ref = c.req.param("ref") ?? "";
  const column = ref.startsWith("p_") ? "id" : "name";
  const project = await c.env.DB.prepare(`SELECT * FROM projects WHERE ${column} = ?`).bind(ref).first<Project>();
  if (!project) return null;
  const owner = c.get("user")?.id === project.owner_id;
  if (project.deleted_at !== null) return owner && opts.trashed ? project : null;
  if (owner) return project;
  return mode === "read" && project.shared === 1 ? project : null;
}

function filePath(c: Ctx): string | null {
  const marker = "/files/";
  const raw = c.req.path.slice(c.req.path.indexOf(marker) + marker.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

app.get("/api/me", (c) => {
  const user = c.get("user");
  return c.json({
    user: user && { email: user.email, name: user.name, lang: user.lang, admin: user.is_admin === 1 },
    siteSuffix: c.env.SITE_SUFFIX,
    contact: c.env.CONTACT ?? "",
  });
});

app.patch("/api/me", async (c) => {
  const user = c.get("user");
  if (!user) return fail(c, 401, "signed-out");
  const { lang } = await c.req.json<{ lang?: string }>();
  if (lang !== "nl" && lang !== "en") return fail(c, 400, "lang");
  await c.env.DB.prepare("UPDATE users SET lang = ? WHERE id = ?").bind(lang, user.id).run();
  return c.json({ ok: true });
});

app.delete("/api/me", async (c) => {
  const user = c.get("user");
  if (!user) return fail(c, 401, "signed-out");
  const { confirm } = await c.req.json<{ confirm?: string }>();
  if ((confirm ?? "").trim().toLowerCase() !== user.email) return fail(c, 400, "confirm");
  const { results } = await c.env.DB.prepare("SELECT id FROM projects WHERE owner_id = ?").bind(user.id).all<{ id: string }>();
  // Removing the project rows takes every shared site offline at once.
  for (const { id } of results) await purgeProject(c.env, id);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM counters WHERE user_id = ?").bind(user.id),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]);
  return c.json({ ok: true });
});

app.get("/api/projects", async (c) => {
  const user = c.get("user");
  if (!user) return fail(c, 401, "signed-out");
  const trash = c.req.query("trash") === "1";
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM projects WHERE owner_id = ? AND deleted_at IS ${trash ? "NOT NULL" : "NULL"} ORDER BY updated_at DESC`,
  )
    .bind(user.id)
    .all<Project>();
  return c.json({ projects: results.map((p) => publicProject(p, user)) });
});

async function mayCreate(c: Ctx, user: User): Promise<Response | null> {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE owner_id = ?").bind(user.id).first<{ n: number }>();
  if (row!.n >= LIMITS.projects) return fail(c, 409, "too-many-projects");
  if ((await count(c.env, user.id, "project", DAY)) > RATE.projectsPerDay) return fail(c, 429, "rate");
  return null;
}

app.post("/api/projects", async (c) => {
  const user = c.get("user");
  if (!user) return fail(c, 401, "signed-out");
  const refused = await mayCreate(c, user);
  if (refused) return refused;
  return c.json({ project: publicProject(await createProject(c.env, user.id, user.lang), user) });
});

app.get("/api/projects/:ref", async (c) => {
  const project = await find(c, "read");
  if (!project) return fail(c, 404, "not-found");
  return c.json({ project: publicProject(project, c.get("user")) });
});

app.patch("/api/projects/:ref", async (c) => {
  let project = await find(c, "write", { trashed: true });
  if (!project) return fail(c, 404, "not-found");
  const body = await c.req.json<{ name?: string; shared?: boolean; trashed?: boolean; resetSecret?: boolean }>();
  const db = c.env.DB;

  if (body.trashed === false && project.deleted_at !== null) {
    await db.prepare("UPDATE projects SET deleted_at = NULL WHERE id = ?").bind(project.id).run();
  } else if (project.deleted_at !== null) {
    return fail(c, 404, "not-found");
  }
  if (typeof body.name === "string" && body.name !== project.name) {
    const problem = nameError(body.name);
    if (problem) return fail(c, 400, `name-${problem}`);
    if (await nameTaken(c.env, body.name, project.id)) return fail(c, 409, "name-taken");
    // The old name redirects for 30 days and is then free again.
    await db.batch([
      db.prepare("DELETE FROM old_names WHERE name = ?").bind(body.name),
      db.prepare("INSERT OR REPLACE INTO old_names (name, project_id, until) VALUES (?, ?, ?)").bind(
        project.name,
        project.id,
        Date.now() + 30 * DAY,
      ),
      db.prepare("UPDATE projects SET name = ? WHERE id = ?").bind(body.name, project.id),
    ]);
  }
  if (typeof body.shared === "boolean") {
    await db.prepare("UPDATE projects SET shared = ? WHERE id = ?").bind(body.shared ? 1 : 0, project.id).run();
  }
  if (body.resetSecret) {
    await db.prepare("UPDATE projects SET secret = ? WHERE id = ?").bind(randomHex(8), project.id).run();
  }
  project = (await db.prepare("SELECT * FROM projects WHERE id = ?").bind(project.id).first<Project>())!;
  return c.json({ project: publicProject(project, c.get("user")) });
});

app.delete("/api/projects/:ref", async (c) => {
  const project = await find(c, "write", { trashed: true });
  if (!project) return fail(c, 404, "not-found");
  if (project.deleted_at !== null) {
    await purgeProject(c.env, project.id);
  } else {
    // A project in the trash is private: its address answers 404 until it is put back.
    await c.env.DB.prepare("UPDATE projects SET deleted_at = ?, shared = 0 WHERE id = ?").bind(Date.now(), project.id).run();
  }
  return c.json({ ok: true });
});

app.post("/api/projects/:ref/copy", async (c) => {
  const user = c.get("user");
  if (!user) return fail(c, 401, "signed-out");
  const source = await find(c, "read");
  if (!source) return fail(c, 404, "not-found");
  const refused = await mayCreate(c, user);
  if (refused) return refused;
  return c.json({ project: publicProject(await copyProject(c.env, source, user.id), user) });
});

app.get("/api/projects/:ref/files", async (c) => {
  const project = await find(c, "read");
  if (!project) return fail(c, 404, "not-found");
  return c.json({ files: await listFiles(c.env, project.id) });
});

app.get("/api/projects/:ref/files/*", async (c) => {
  const project = await find(c, "read");
  const path = filePath(c);
  if (!project || !path) return fail(c, 404, "not-found");
  const row = await c.env.DB.prepare("SELECT hash, rev, kind FROM files WHERE project_id = ? AND path = ?")
    .bind(project.id, path)
    .first<{ hash: string; rev: number; kind: string }>();
  if (!row || row.kind !== "file") return fail(c, 404, "not-found");
  const object = await c.env.FILES.get(blobKey(project.id, row.hash));
  if (!object) return fail(c, 404, "not-found");
  // Student files are data on this origin. They must never be shown as a page here.
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment",
      "Content-Security-Policy": "sandbox",
      "X-Rev": String(row.rev),
      "Cache-Control": "no-store",
    },
  });
});

app.put("/api/projects/:ref/files/*", async (c) => {
  const user = c.get("user");
  if (!user) return fail(c, 401, "signed-out");
  const project = await find(c, "write");
  const path = filePath(c);
  if (!project || path === null) return fail(c, 404, "not-found");
  const problem = pathError(path);
  if (problem) return fail(c, 400, `path-${problem}`);
  const db = c.env.DB;

  const existing = await db.prepare("SELECT kind, size, rev FROM files WHERE project_id = ? AND path = ?")
    .bind(project.id, path)
    .first<{ kind: string; size: number; rev: number }>();

  if (c.req.query("folder") === "1") {
    if (existing) return fail(c, 409, "exists");
    const blocked = await ensureParents(c.env, project.id, `${path}/x`);
    if (blocked) return fail(c, 409, blocked);
    await nextRev(c.env, project.id);
    return c.json({ ok: true });
  }

  if (!contentType(path)) return fail(c, 415, "type");
  if (existing?.kind === "folder") return fail(c, 409, "exists");
  // If-Match carries the revision the editor last saw. 0 means: this file should not exist yet.
  const ifMatch = c.req.header("If-Match");
  if (ifMatch !== undefined && Number(ifMatch) !== (existing?.rev ?? 0)) {
    return fail(c, 412, "conflict", { rev: existing?.rev ?? 0 });
  }
  if (Number(c.req.header("Content-Length") ?? 0) > LIMITS.file) return fail(c, 413, "file-too-large");
  if ((await count(c.env, user.id, "save", 60_000)) > RATE.savesPerMinute) return fail(c, 429, "rate");

  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > LIMITS.file) return fail(c, 413, "file-too-large");
  if ((await count(c.env, user.id, "bytes", DAY, bytes.byteLength)) > RATE.uploadBytesPerDay) return fail(c, 429, "rate");
  const totals = await db.prepare(
    "SELECT COALESCE(SUM(size), 0) AS size, COUNT(*) AS n FROM files WHERE project_id = ? AND kind = 'file'",
  )
    .bind(project.id)
    .first<{ size: number; n: number }>();
  if (!existing && totals!.n >= LIMITS.files) return fail(c, 409, "too-many-files");
  if (totals!.size - (existing?.size ?? 0) + bytes.byteLength > LIMITS.project) return fail(c, 413, "project-too-large");

  const blocked = await ensureParents(c.env, project.id, path);
  if (blocked) return fail(c, 409, blocked);
  await snapshotIfDue(c.env, project);

  // Bytes first, row second. A failure in between leaves an unused object and no broken file.
  const hash = await sha256(bytes);
  await c.env.FILES.put(blobKey(project.id, hash), bytes);
  const rev = await nextRev(c.env, project.id);
  const now = Date.now();
  if (existing) {
    const done = await db.prepare(
      "UPDATE files SET hash = ?, size = ?, rev = ?, updated_at = ? WHERE project_id = ? AND path = ? AND rev = ?",
    )
      .bind(hash, bytes.byteLength, rev, now, project.id, path, existing.rev)
      .run();
    if (done.meta.changes !== 1) return fail(c, 412, "conflict", { rev: 0 });
  } else {
    const done = await db.prepare(
      "INSERT OR IGNORE INTO files (project_id, path, kind, hash, size, rev, updated_at) VALUES (?, ?, 'file', ?, ?, ?, ?)",
    )
      .bind(project.id, path, hash, bytes.byteLength, rev, now)
      .run();
    if (done.meta.changes !== 1) return fail(c, 412, "conflict", { rev: 0 });
  }
  return c.json({ rev, hash, size: bytes.byteLength, updated_at: now });
});

app.delete("/api/projects/:ref/files/*", async (c) => {
  const project = await find(c, "write");
  const path = filePath(c);
  if (!project || !path) return fail(c, 404, "not-found");
  const row = await c.env.DB.prepare("SELECT kind FROM files WHERE project_id = ? AND path = ?")
    .bind(project.id, path)
    .first<{ kind: string }>();
  if (!row) return fail(c, 404, "not-found");
  await takeSnapshot(c.env, project.id);
  const done = await c.env.DB.prepare(
    "DELETE FROM files WHERE project_id = ?1 AND (path = ?2 OR substr(path, 1, length(?2) + 1) = ?2 || '/')",
  )
    .bind(project.id, path)
    .run();
  await nextRev(c.env, project.id);
  return c.json({ deleted: done.meta.changes });
});

app.post("/api/projects/:ref/move", async (c) => {
  const project = await find(c, "write");
  if (!project) return fail(c, 404, "not-found");
  const { from, to } = await c.req.json<{ from?: string; to?: string }>();
  if (typeof from !== "string" || typeof to !== "string") return fail(c, 400, "path-empty");
  const problem = pathError(to);
  if (problem) return fail(c, 400, `path-${problem}`);
  if (to === from) return c.json({ ok: true });
  if (to.startsWith(`${from}/`)) return fail(c, 400, "into-itself");
  const db = c.env.DB;
  const rows = await db.prepare("SELECT path, kind FROM files WHERE project_id = ? AND path IN (?, ?)")
    .bind(project.id, from, to)
    .all<{ path: string; kind: string }>();
  const source = rows.results.find((r) => r.path === from);
  if (!source) return fail(c, 404, "not-found");
  if (rows.results.some((r) => r.path === to)) return fail(c, 409, "exists");
  if (source.kind === "file" && !contentType(to)) return fail(c, 415, "type");
  const blocked = await ensureParents(c.env, project.id, to);
  if (blocked) return fail(c, 409, blocked);
  // A move changes rows only. The bytes stay where they are, under their hash.
  await db.prepare(
    `UPDATE files SET path = ?3 || substr(path, length(?2) + 1)
     WHERE project_id = ?1 AND (path = ?2 OR substr(path, 1, length(?2) + 1) = ?2 || '/')`,
  )
    .bind(project.id, from, to)
    .run();
  await nextRev(c.env, project.id);
  return c.json({ ok: true });
});

app.get("/api/projects/:ref/snapshots", async (c) => {
  const project = await find(c, "write");
  if (!project) return fail(c, 404, "not-found");
  return c.json({ snapshots: await listSnapshots(c.env, project.id) });
});

app.post("/api/projects/:ref/snapshots", async (c) => {
  const project = await find(c, "write");
  if (!project) return fail(c, 404, "not-found");
  return c.json({ id: await takeSnapshot(c.env, project.id) });
});

app.post("/api/projects/:ref/snapshots/:sid/restore", async (c) => {
  const project = await find(c, "write");
  if (!project) return fail(c, 404, "not-found");
  if (!(await restoreSnapshot(c.env, project.id, c.req.param("sid")))) return fail(c, 404, "not-found");
  return c.json({ files: await listFiles(c.env, project.id) });
});

// The report form is public by design. It stores no personal data and is capped in size and number.
app.post("/api/reports", async (c) => {
  const { name, reason } = await c.req.json<{ name?: string; reason?: string }>();
  if (typeof name !== "string" || typeof reason !== "string") return fail(c, 400, "report");
  // People paste an address as often as a name. Keep the first label of it.
  const cleanName = name.trim().toLowerCase().replace(/^https?:\/\//, "").split(/[./]/)[0].split("--")[0];
  if (!/^[a-z0-9-]{3,40}$/.test(cleanName)) return fail(c, 400, "report");
  if (!reason.trim() || reason.length > 2000) return fail(c, 400, "report");
  const open = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE handled_at IS NULL").first<{ n: number }>();
  if (open!.n >= 500) return fail(c, 429, "rate");
  await c.env.DB.prepare("INSERT INTO reports (project_name, reason, created_at) VALUES (?, ?, ?)")
    .bind(cleanName, reason.trim(), Date.now())
    .run();
  return c.json({ ok: true });
});

app.use("/api/admin/*", async (c, next) => {
  if (c.get("user")?.is_admin !== 1) return fail(c, 404, "not-found");
  await next();
});

app.get("/api/admin/state", async (c) => {
  const db = c.env.DB;
  const [allowed, invites, reports] = await db.batch([
    db.prepare("SELECT pattern, note FROM allowed ORDER BY pattern"),
    db.prepare("SELECT code, uses_left, expires_at FROM invites WHERE expires_at > ? ORDER BY expires_at").bind(Date.now()),
    db.prepare(
      "SELECT r.id, r.project_name, r.reason, r.created_at, r.handled_at, p.shared FROM reports r LEFT JOIN projects p ON p.name = r.project_name ORDER BY r.handled_at IS NOT NULL, r.created_at DESC LIMIT 200",
    ),
  ]);
  return c.json({ allowed: allowed.results, invites: invites.results, reports: reports.results });
});

app.post("/api/admin/allowed", async (c) => {
  const { pattern, note } = await c.req.json<{ pattern?: string; note?: string }>();
  const clean = (pattern ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!/^([^\s@]+@)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean)) return fail(c, 400, "pattern");
  await c.env.DB.prepare("INSERT OR REPLACE INTO allowed (pattern, note) VALUES (?, ?)")
    .bind(clean, (note ?? "").slice(0, 200))
    .run();
  return c.json({ ok: true });
});

app.delete("/api/admin/allowed", async (c) => {
  const { pattern } = await c.req.json<{ pattern?: string }>();
  const clean = pattern ?? "";
  // Removing an entry also ends the sessions it covered. A person who is still allowed by
  // another entry signs in again; anyone else is refused at that point.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM allowed WHERE pattern = ?").bind(clean),
    c.env.DB.prepare(
      "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?1 OR substr(email, instr(email, '@') + 1) = ?1)",
    ).bind(clean),
  ]);
  return c.json({ ok: true });
});

app.post("/api/admin/invites", async (c) => {
  const { uses, days } = await c.req.json<{ uses?: number; days?: number }>();
  const code = randomHex(6);
  await c.env.DB.prepare("INSERT INTO invites (code, uses_left, expires_at) VALUES (?, ?, ?)")
    .bind(code, Math.min(Math.max(Math.floor(uses ?? 30), 1), 500), Date.now() + Math.min(Math.max(days ?? 14, 1), 90) * DAY)
    .run();
  return c.json({ code });
});

app.post("/api/admin/reports/:id", async (c) => {
  const { unshare } = await c.req.json<{ unshare?: boolean }>();
  const db = c.env.DB;
  const report = await db.prepare("SELECT project_name FROM reports WHERE id = ?").bind(c.req.param("id")).first<{ project_name: string }>();
  if (!report) return fail(c, 404, "not-found");
  if (unshare) await db.prepare("UPDATE projects SET shared = 0 WHERE name = ?").bind(report.project_name).run();
  await db.prepare("UPDATE reports SET handled_at = ? WHERE id = ?").bind(Date.now(), c.req.param("id")).run();
  return c.json({ ok: true });
});

app.all("/api/*", (c) => fail(c, 404, "not-found"));
app.all("/auth/*", (c) => fail(c, 404, "not-found"));

// Everything else is the editor app. Unknown paths get index.html, and the app routes on the path.
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export async function appFetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const inner = await app.fetch(req, env, ctx);
  const res = new Response(inner.body, inner);
  const h = res.headers;
  if (!h.has("Content-Security-Policy")) {
    h.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        `frame-src ${url.protocol}//*.${env.SITE_SUFFIX}`,
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
      ].join("; "),
    );
  }
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "same-origin");
  if (url.protocol === "https:") h.set("Strict-Transport-Security", "max-age=31536000");
  return res;
}

export type { FileRow };
