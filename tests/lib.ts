// HTTP helpers for the API tests. Requests go to 127.0.0.1 with an explicit Host header,
// because Node does not resolve <name>.localhost the way browsers do.

import { spawnSync } from "node:child_process";
import { request } from "node:http";

export const APP = "localhost:8787";
export const ORIGIN = `http://${APP}`;
export const site = (label: string) => `${label}.localhost:8787`;

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: any;
  bytes: Buffer;
}

interface Options {
  cookie?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | object;
  /** Leave out the Origin header that the editor would send. */
  noOrigin?: boolean;
}

export function call(host: string, method: string, path: string, opts: Options = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: host };
    let body: Buffer | undefined;
    if (opts.body !== undefined) {
      if (Buffer.isBuffer(opts.body)) {
        body = opts.body;
        headers["Content-Type"] = "application/octet-stream";
      } else if (typeof opts.body === "string") {
        body = Buffer.from(opts.body);
        headers["Content-Type"] = "application/octet-stream";
      } else {
        body = Buffer.from(JSON.stringify(opts.body));
        headers["Content-Type"] = "application/json";
      }
      headers["Content-Length"] = String(body.length);
    } else if (method !== "GET" && method !== "HEAD") {
      headers["Content-Type"] = "application/json";
    }
    if (method !== "GET" && method !== "HEAD" && !opts.noOrigin) headers.Origin = ORIGIN;
    if (opts.cookie) headers.Cookie = opts.cookie;
    Object.assign(headers, opts.headers);
    const req = request({ host: "127.0.0.1", port: 8787, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString("utf8");
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json, bytes });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookiesOf(reply: Reply): string {
  const set = reply.headers["set-cookie"];
  const list = Array.isArray(set) ? set : set ? [set] : [];
  return list
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

export interface SignIn {
  cookie: string;
  /** Where the app sends the person after sign-in. */
  location: string;
}

/** Walks the real sign-in flow through the local provider. */
export async function signIn(email: string, opts: { next?: string; invite?: string } = {}): Promise<SignIn> {
  const query = new URLSearchParams({ next: opts.next ?? "/projects" });
  if (opts.invite) query.set("invite", opts.invite);
  const start = await call(APP, "GET", `/auth/login?${query}`);
  const flow = cookiesOf(start);
  const provider = await fetch(`${start.headers.location}&as=${encodeURIComponent(email)}`, { redirect: "manual" });
  const back = new URL(provider.headers.get("location")!);
  const done = await call(APP, "GET", back.pathname + back.search, { cookie: flow });
  return { cookie: cookiesOf(done), location: String(done.headers.location) };
}

export const filesUrl = (project: string, path = "") =>
  `/api/projects/${project}/files${path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : ""}`;

let admin: SignIn | null = null;

/** Signs in the admin once and puts school.test on the allow-list. */
export async function setUp(): Promise<SignIn> {
  if (admin) return admin;
  admin = await signIn("admin@school.test");
  await call(APP, "POST", "/api/admin/allowed", { cookie: admin.cookie, body: { pattern: "school.test", note: "tests" } });
  return admin;
}

/** A fresh person on the allow-list with one new project. */
export async function person(tag: string) {
  await setUp();
  const email = `${tag}-${Math.random().toString(36).slice(2, 8)}@school.test`;
  const { cookie } = await signIn(email);
  const made = await call(APP, "POST", "/api/projects", { cookie });
  if (made.status !== 200) throw new Error(`could not create a project: ${made.status} ${made.text}`);
  return { email, cookie, project: made.json.project as { id: string; name: string; secret: string } };
}

/**
 * Runs SQL on the test database, next to the running Worker. For states that take too long to
 * reach through the API, such as a full quota or a busy day.
 */
export function sql(command: string): void {
  const run = spawnSync(
    "node_modules/.bin/wrangler",
    ["d1", "execute", "maak", "--local", "--persist-to", ".wrangler/test", "--command", command],
    { encoding: "utf8", env: { ...process.env, CI: "1" } },
  );
  if (run.status !== 0) throw new Error(`sql failed: ${run.stderr || run.stdout}`);
}
