// Sign-in with OpenID Connect: authorization code flow with PKCE, state and nonce.
// maak.io stores no passwords. The session is a random value in a __Host- cookie.

import { DAY, type Env, type User, randomHex, sha256 } from "./env";
import { createProject } from "./projects";

const SESSION_COOKIE = "__Host-session";
const FLOW_COOKIE = "__Host-flow";
const SESSION_DAYS = 30;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Flow {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  invite: string;
}

let discoveryCache: { issuer: string; doc: Discovery } | null = null;
let jwksCache: { uri: string; keys: JsonWebKey[]; at: number } | null = null;

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const b of view) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string) {
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function discover(env: Env): Promise<Discovery> {
  const issuer = env.OIDC_ISSUER.replace(/\/$/, "");
  // A plain-http provider is the local development provider. Production must not accept one.
  if (!issuer.startsWith("https://") && !env.APP_HOST.startsWith("localhost:")) {
    throw new Error("OIDC_ISSUER must use https");
  }
  if (discoveryCache?.issuer === issuer) return discoveryCache.doc;
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
  const doc = (await res.json()) as Discovery;
  discoveryCache = { issuer, doc };
  return doc;
}

async function signingKey(uri: string, kid: string | undefined): Promise<JsonWebKey | null> {
  const find = (keys: JsonWebKey[]) =>
    keys.find((k) => (k as { kid?: string }).kid === kid) ?? (kid ? null : keys[0]) ?? null;
  if (jwksCache?.uri === uri && Date.now() - jwksCache.at < 3600_000) {
    const hit = find(jwksCache.keys);
    if (hit) return hit;
  }
  const res = await fetch(uri);
  if (!res.ok) return null;
  const { keys } = (await res.json()) as { keys: JsonWebKey[] };
  jwksCache = { uri, keys, at: Date.now() };
  return find(keys);
}

interface Claims {
  iss: string;
  aud: string | string[];
  exp: number;
  sub: string;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

async function verifyIdToken(token: string, doc: Discovery, env: Env, nonce: string): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const decode = (part: string) => JSON.parse(new TextDecoder().decode(unb64url(part)));
  const header = decode(parts[0]) as { alg: string; kid?: string };
  if (header.alg !== "RS256") return null;
  const jwk = await signingKey(doc.jwks_uri, header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64url(parts[2]), signed))) return null;
  const claims = decode(parts[1]) as Claims;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== doc.issuer) return null;
  if (!audiences.includes(env.OIDC_CLIENT_ID)) return null;
  if (!(claims.exp * 1000 > Date.now())) return null;
  if (claims.nonce !== nonce) return null;
  return claims;
}

export function adminEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS ?? "").split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function mayEnter(env: Env, email: string, invite: string): Promise<boolean> {
  if (adminEmails(env).includes(email)) return true;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const hit = await env.DB.prepare("SELECT 1 FROM allowed WHERE pattern IN (?, ?) LIMIT 1")
    .bind(email, domain)
    .first();
  if (hit) return true;
  if (!invite) return false;
  const used = await env.DB.prepare(
    "UPDATE invites SET uses_left = uses_left - 1 WHERE code = ? AND uses_left > 0 AND expires_at > ?",
  )
    .bind(invite, Date.now())
    .run();
  if (used.meta.changes !== 1) return false;
  await env.DB.prepare("INSERT OR IGNORE INTO allowed (pattern, note) VALUES (?, ?)")
    .bind(email, `invite ${invite}`)
    .run();
  return true;
}

function safeNext(next: string | null): string {
  return next && /^\/[^/\\]/.test(next) ? next : "/";
}

export async function login(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  // Without a client the site stays locked: nobody can start a sign-in.
  if (!env.OIDC_CLIENT_ID) return new Response(null, { status: 302, headers: { Location: "/?refused=closed" } });
  const doc = await discover(env);
  const flow: Flow = {
    state: randomHex(16),
    nonce: randomHex(16),
    verifier: randomHex(32),
    next: safeNext(url.searchParams.get("next")),
    invite: (url.searchParams.get("invite") ?? "").slice(0, 64),
  };
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(flow.verifier)));
  const to = new URL(doc.authorization_endpoint);
  to.searchParams.set("response_type", "code");
  to.searchParams.set("client_id", env.OIDC_CLIENT_ID);
  to.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
  to.searchParams.set("scope", "openid email profile");
  to.searchParams.set("state", flow.state);
  to.searchParams.set("nonce", flow.nonce);
  to.searchParams.set("code_challenge", challenge);
  to.searchParams.set("code_challenge_method", "S256");
  return new Response(null, {
    status: 302,
    headers: {
      Location: to.toString(),
      "Set-Cookie": cookie(FLOW_COOKIE, b64url(new TextEncoder().encode(JSON.stringify(flow))), 600),
    },
  });
}

function leave(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

export async function callback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const clearFlow = cookie(FLOW_COOKIE, "", 0);
  const refused = (why: string) => leave(`/?refused=${why}`, [clearFlow]);

  const raw = readCookie(req, FLOW_COOKIE);
  const code = url.searchParams.get("code");
  if (!raw || !code) return refused("flow");
  let flow: Flow;
  try {
    flow = JSON.parse(new TextDecoder().decode(unb64url(raw)));
  } catch {
    return refused("flow");
  }
  if (url.searchParams.get("state") !== flow.state) return refused("flow");

  const doc = await discover(env);
  const tokenRes = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${url.origin}/auth/callback`,
      client_id: env.OIDC_CLIENT_ID,
      client_secret: env.OIDC_CLIENT_SECRET ?? "",
      code_verifier: flow.verifier,
    }),
  });
  if (!tokenRes.ok) return refused("provider");
  const { id_token } = (await tokenRes.json()) as { id_token?: string };
  const claims = id_token ? await verifyIdToken(id_token, doc, env, flow.nonce) : null;
  if (!claims) return refused("provider");
  if (!claims.email || claims.email_verified !== true) return refused("email");

  const email = claims.email.toLowerCase();
  if (!(await mayEnter(env, email, flow.invite))) return refused("invite");

  const now = Date.now();
  const isAdmin = adminEmails(env).includes(email) ? 1 : 0;
  let next = flow.next;
  let user = await env.DB.prepare("SELECT id, suspended_at FROM users WHERE provider = ? AND subject = ?")
    .bind(doc.issuer, claims.sub)
    .first<{ id: string; suspended_at: number | null }>();
  if (user?.suspended_at && !isAdmin) return refused("suspended");
  if (user) {
    await env.DB.prepare("UPDATE users SET email = ?, is_admin = ?, seen_at = ? WHERE id = ?")
      .bind(email, isAdmin, now, user.id)
      .run();
  } else {
    user = { id: `u_${randomHex(8)}`, suspended_at: null };
    const lang = (req.headers.get("Accept-Language") ?? "").toLowerCase().startsWith("en") ? "en" : "nl";
    await env.DB.prepare(
      "INSERT INTO users (id, provider, subject, email, name, lang, is_admin, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(user.id, doc.issuer, claims.sub, email, claims.name ?? email.split("@")[0], lang, isAdmin, now, now)
      .run();
    // A first sign-in lands directly in a new project, unless the person followed a link.
    if (next === "/") {
      const project = await createProject(env, user.id, lang);
      next = `/e/${project.name}`;
    }
  }

  const token = randomHex(32);
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), user.id, now + SESSION_DAYS * DAY)
    .run();
  return leave(next, [clearFlow, cookie(SESSION_COOKIE, token, SESSION_DAYS * 24 * 3600)]);
}

export async function logout(req: Request, env: Env): Promise<Response> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256(token)).run();
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", "Set-Cookie": cookie(SESSION_COOKIE, "", 0) },
  });
}

export async function currentUser(req: Request, env: Env): Promise<User | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const now = Date.now();
  const user = await env.DB.prepare(
    "SELECT u.id, u.email, u.name, u.lang, u.is_admin, u.seen_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND u.suspended_at IS NULL",
  )
    .bind(await sha256(token), now)
    .first<User>();
  if (user && now - user.seen_at > 3600_000) {
    await env.DB.prepare("UPDATE users SET seen_at = ? WHERE id = ?").bind(now, user.id).run();
  }
  return user;
}
