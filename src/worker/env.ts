export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  /** Host of the editor, such as maak.io. */
  APP_HOST: string;
  /** Student sites live at <name>.<SITE_SUFFIX>. Equal to APP_HOST on one domain. */
  SITE_SUFFIX: string;
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET?: string;
  /** Comma-separated addresses that may always sign in and are admins. */
  ADMIN_EMAILS?: string;
  CONTACT?: string;
  /** The git commit of this build, set at deploy with --var COMMIT:<sha>. */
  COMMIT?: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  /** Sends a note to the admins when someone files a report. */
  MAIL?: SendEmail;
  /** The sender for that note, on a domain onboarded to Cloudflare Email Sending. */
  MAIL_FROM?: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  lang: string;
  is_admin: number;
  seen_at: number;
  /** Bytes the person's projects hold in R2, history and trash included. */
  held_bytes: number;
}

export interface Project {
  id: string;
  owner_id: string;
  name: string;
  secret: string;
  shared: number;
  copied_from: string | null;
  rev_seq: number;
  snapshot_at: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  blocked_reason: string | null;
}

export interface FileRow {
  path: string;
  kind: "file" | "folder";
  hash: string;
  size: number;
  rev: number;
  updated_at: number;
}

export const DAY = 24 * 60 * 60 * 1000;

export function adminEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS ?? "").split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Sends a note to the admins. A failed send is logged; the caller has stored what matters. */
export async function mailAdmins(env: Env, subject: string, text: string): Promise<void> {
  const to = adminEmails(env);
  if (!env.MAIL || !env.MAIL_FROM || to.length === 0) return;
  try {
    await env.MAIL.send({ from: { email: env.MAIL_FROM, name: "maak.io" }, to, subject, text });
  } catch (e) {
    console.error("mail", subject, (e as { code?: string }).code ?? "", (e as Error).message);
  }
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

export function randomHex(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(data: ArrayBuffer | Uint8Array<ArrayBuffer> | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

/** Compares two strings in time that does not depend on where they differ. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function blobKey(projectId: string, hash: string): string {
  return `projects/${projectId}/${hash}`;
}
