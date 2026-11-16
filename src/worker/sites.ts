// Student sites. The host name decides everything:
//   <name>.<suffix>                 the shared site, 404 while the project is private
//   <name>--<secret>.<suffix>       the preview alias, with the helper script in HTML
//   <name>--<secret>--<n>.<suffix>  the same alias under another host name (see below)
//   0--<secret>--<snapshot>.<suffix> one history snapshot, as a preview
//
// Why the alias has numbered twins: a page that hangs (while (true) {}) keeps its browser process
// stuck for as long as the tab lives, and Chrome gives every new frame on that origin the same
// stuck process. The editor restarts a stuck preview on the next number. The Origin-Agent-Cluster
// header asks the browser for a process per origin, so the twin gets a fresh one, and a hanging
// preview cannot freeze an editor on the same domain. experiments/ holds the two tests behind this.
// Student code is only read from storage and sent out. The Worker sets no cookie here.

import { contentType } from "../shared/rules";
import { type Env, type Project, blobKey, sameString } from "./env";
import { injectHelper } from "./helper";
import { readSnapshot } from "./projects";

/** Projects that may be served: not in the trash, and the owner is not suspended. */
const LIVE =
  "SELECT p.* FROM projects p JOIN users u ON u.id = p.owner_id AND u.suspended_at IS NULL WHERE p.deleted_at IS NULL AND";

interface Entry {
  kind: string;
  hash: string;
  size: number;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

function plain404(env: Env, url: URL, path: string): string {
  const report = `${url.protocol}//${env.APP_HOST}/report`;
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404</title>
<style>
@font-face { font-family: "Atkinson Hyperlegible Next"; font-weight: 200 800; font-display: swap; src: url("${url.protocol}//${env.APP_HOST}/fonts/atkinson-hyperlegible-next.woff2") format("woff2"); }
body { font: 16px/1.5 "Atkinson Hyperlegible Next", system-ui, sans-serif; margin: 3rem; }
</style>
<body>
<h1 style="font-size: 1.25rem">404</h1>
<p>Er is geen bestand op <code>${escapeHtml(path)}</code>.<br>There is no file at <code>${escapeHtml(path)}</code>.</p>
<p style="color: #666; font-size: 0.875rem">maak.io · <a href="${report}" style="color: inherit">Meld een probleem / Report a problem</a></p>
</body>
</html>
`;
}

function parseRange(header: string | null, size: number): { offset: number; length: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!m || (!m[1] && !m[2]) || size === 0) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(size - Number(m[2]), 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return null;
  return { offset: start, length: end - start + 1 };
}

/**
 * Whether a page on another site asks for this file: an <img>, <video>, fetch or frame there.
 * Browsers say so in Sec-Fetch-Site. Every student site is same-site with the others, so between
 * them the Referer decides. A link that opens the file, a frame that holds a page, and a request
 * without these headers (curl, a link preview, an old browser) are served.
 */
function embeddedElsewhere(req: Request, url: URL, html: boolean): boolean {
  const dest = req.headers.get("Sec-Fetch-Dest");
  if (dest === "document" || (html && (dest === "iframe" || dest === "frame"))) return false;
  const site = req.headers.get("Sec-Fetch-Site");
  if (site === "cross-site") return true;
  if (site !== "same-site") return false;
  const referer = req.headers.get("Referer");
  if (!referer) return false;
  try {
    return new URL(referer).host !== url.host;
  } catch {
    return true;
  }
}

export async function serveSite(req: Request, env: Env, label: string): Promise<Response> {
  const url = new URL(req.url);
  const db = env.DB;
  const parts = label.split("--");
  const alias = parts.length > 1;
  const headers = new Headers({
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
    "X-Robots-Tag": "noindex",
    "Origin-Agent-Cluster": "?1",
  });
  if (alias) headers.set("Referrer-Policy", "no-referrer");
  const notFound = (path: string, inject = false) => {
    headers.set("Content-Type", "text/html; charset=utf-8");
    const body = plain404(env, url, path);
    return new Response(inject ? injectHelper(body, `${url.protocol}//${env.APP_HOST}`) : body, { status: 404, headers });
  };

  let project: Project | null = null;
  let snapshot: Map<string, Entry> | null = null;
  if (parts.length === 1) {
    project = await db.prepare(`${LIVE} p.name = ?`).bind(label).first<Project>();
    if (!project) {
      // A renamed project answers on its old name for 30 days.
      const moved = await db.prepare(
        "SELECT p.name FROM old_names o JOIN projects p ON p.id = o.project_id WHERE o.name = ? AND o.until > ? AND p.shared = 1 AND p.deleted_at IS NULL",
      )
        .bind(label, Date.now())
        .first<{ name: string }>();
      if (moved) {
        return Response.redirect(`${url.protocol}//${moved.name}.${env.SITE_SUFFIX}${url.pathname}${url.search}`, 302);
      }
    }
    if (!project || project.shared !== 1) return notFound(url.pathname);
  } else if (parts.length === 2 || (parts.length === 3 && parts[0] !== "0" && /^\d{1,3}$/.test(parts[2]))) {
    project = await db.prepare(`${LIVE} p.name = ?`).bind(parts[0]).first<Project>();
    if (!project || !sameString(project.secret, parts[1])) return notFound(url.pathname);
  } else if (parts.length === 3 && parts[0] === "0") {
    project = await db.prepare(`${LIVE} p.secret = ?`).bind(parts[1]).first<Project>();
    const manifest = project && (await readSnapshot(env, project.id, parts[2]));
    if (!project || !manifest) return notFound(url.pathname);
    snapshot = new Map(manifest.map((f) => [f.path, f]));
  } else {
    return notFound(url.pathname);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  let path: string;
  try {
    path = decodeURIComponent(url.pathname).slice(1);
  } catch {
    return notFound(url.pathname, alias);
  }
  const lookup = async (p: string): Promise<Entry | null> =>
    snapshot
      ? (snapshot.get(p) ?? null)
      : db.prepare("SELECT kind, hash, size FROM files WHERE project_id = ? AND path = ?").bind(project.id, p).first<Entry>();

  // Paths match exactly and are case-sensitive, as on a real server. A folder serves its index.html.
  let status = 200;
  if (path === "" || path.endsWith("/")) path += "index.html";
  let entry = await lookup(path);
  if (entry?.kind === "folder") {
    return Response.redirect(`${url.origin}/${path.split("/").map(encodeURIComponent).join("/")}/${url.search}`, 302);
  }
  if (!entry) {
    entry = await lookup("404.html");
    if (entry?.kind !== "file") return notFound(url.pathname, alias);
    path = "404.html";
    status = 404;
  }

  const type = contentType(path) ?? "application/octet-stream";
  const html = type.startsWith("text/html");
  // Hotlinks cost a request each, and a video on a busy page elsewhere makes many. The alias is
  // left out: the project list draws it in a sandboxed frame, whose requests count as cross-site.
  if (!alias && embeddedElsewhere(req, url, html)) {
    headers.set("Content-Type", "text/plain; charset=utf-8");
    return new Response("This file can be used on its own site only.\n", { status: 403, headers });
  }
  const withHelper = alias && html;
  const etag = `"${entry.hash}${withHelper ? "-h" : ""}"`;
  headers.set("Content-Type", type);
  headers.set("ETag", etag);
  headers.set("Accept-Ranges", "bytes");
  if (status === 200 && req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });

  if (withHelper) {
    const object = await env.FILES.get(blobKey(project.id, entry.hash));
    if (!object) return notFound(url.pathname, true);
    const body = injectHelper(await object.text(), `${url.protocol}//${env.APP_HOST}`);
    return new Response(req.method === "HEAD" ? null : body, { status, headers });
  }

  const range = status === 200 ? parseRange(req.headers.get("Range"), entry.size) : null;
  const object = await env.FILES.get(blobKey(project.id, entry.hash), range ? { range } : undefined);
  if (!object) return notFound(url.pathname, alias);
  if (range) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${entry.size}`);
    headers.set("Content-Length", String(range.length));
    status = 206;
  } else {
    headers.set("Content-Length", String(entry.size));
  }
  return new Response(req.method === "HEAD" ? null : object.body, { status, headers });
}
