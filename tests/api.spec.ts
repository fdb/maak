import { expect, test } from "@playwright/test";
import { APP, ORIGIN, call, filesUrl, person, setUp, signIn, site } from "./lib";

const put = (cookie: string, project: string, path: string, body: string | Buffer, rev?: number) =>
  call(APP, "PUT", filesUrl(project, path), {
    cookie,
    body,
    headers: rev === undefined ? {} : { "If-Match": String(rev) },
  });

const read = async (cookie: string, project: string, path: string) =>
  (await call(APP, "GET", filesUrl(project, path), { cookie })).text;

const revOf = async (cookie: string, project: string, path: string): Promise<number> =>
  (await call(APP, "GET", filesUrl(project), { cookie })).json.files.find((f: any) => f.path === path).rev;

test.describe("sign-in", () => {
  test("an invited person signs in, anyone else is refused", async () => {
    await setUp();
    const inside = await signIn("student@school.test");
    expect(inside.cookie).toContain("__Host-session=");
    const me = await call(APP, "GET", "/api/me", { cookie: inside.cookie });
    expect(me.json.user.email).toBe("student@school.test");

    const outside = await signIn("eve@elsewhere.test");
    expect(outside.location).toBe("/?refused=invite");
    expect(outside.cookie).not.toContain("__Host-session=");
  });

  test("a person outside the allow-list cannot create a project", async () => {
    const outside = await signIn("mallory@elsewhere.test");
    const made = await call(APP, "POST", "/api/projects", { cookie: outside.cookie });
    expect(made.status).toBe(401);
    expect((await call(APP, "POST", "/api/projects")).status).toBe(401);
  });

  test("an unverified email is refused", async () => {
    await setUp();
    expect((await signIn("unverified@school.test")).location).toBe("/?refused=email");
  });

  test("an invite code lets in a private address, a limited number of times", async () => {
    const admin = await setUp();
    const invite = await call(APP, "POST", "/api/admin/invites", { cookie: admin.cookie, body: { uses: 1, days: 1 } });
    const code = invite.json.code as string;
    expect((await signIn("guest@gmail.test", { invite: code })).cookie).toContain("__Host-session=");
    // The address is now on the list, so the next sign-in needs no code.
    expect((await signIn("guest@gmail.test")).cookie).toContain("__Host-session=");
    expect((await signIn("second@gmail.test", { invite: code })).location).toBe("/?refused=invite");
  });

  test("a first sign-in lands in a new project with the starter files", async () => {
    await setUp();
    const first = await signIn(`first-${Date.now()}@school.test`, { next: "/" });
    expect(first.location).toMatch(/^\/e\/[a-z]+-[a-z]+/);
    const name = first.location.slice(3);
    const files = await call(APP, "GET", filesUrl(name), { cookie: first.cookie });
    expect(files.json.files.map((f: any) => f.path)).toEqual(["index.html", "script.js", "style.css"]);
  });

  test("the session cookie is tied to the exact host and hidden from scripts", async () => {
    const start = await call(APP, "GET", "/auth/login");
    const flow = String(start.headers["set-cookie"]);
    expect(flow).toContain("__Host-flow=");
    expect(flow).toContain("HttpOnly");
    expect(flow).toContain("Secure");
    expect(flow).toContain("SameSite=Lax");
    expect(flow).not.toContain("Domain=");
  });

  test("a state that does not match is refused", async () => {
    const start = await call(APP, "GET", "/auth/login");
    const flow = String(start.headers["set-cookie"]).split(";")[0];
    const back = await call(APP, "GET", "/auth/callback?code=x&state=wrong", { cookie: flow });
    expect(back.headers.location).toBe("/?refused=flow");
  });
});

test.describe("serving", () => {
  test("a project renders on its alias, and on its own address only while shared", async () => {
    const a = await person("serve");
    const alias = site(`${a.project.name}--${a.project.secret}`);
    const open = site(a.project.name);

    const preview = await call(alias, "GET", "/");
    expect(preview.status).toBe(200);
    expect(preview.text).toContain("<h1>");
    expect(preview.text).toContain("maak-helper.js");
    expect(preview.headers["referrer-policy"]).toBe("no-referrer");
    expect(preview.headers["set-cookie"]).toBeUndefined();

    expect((await call(open, "GET", "/")).status).toBe(404);
    expect((await call(site(`${a.project.name}--0000000000000000`), "GET", "/")).status).toBe(404);
    // A numbered twin of the alias serves the same files, and needs the same secret.
    const twin = await call(site(`${a.project.name}--${a.project.secret}--7`), "GET", "/");
    expect(twin.text).toBe(preview.text);
    expect(twin.headers["origin-agent-cluster"]).toBe("?1");
    expect((await call(site(`${a.project.name}--0000000000000000--7`), "GET", "/")).status).toBe(404);
    expect((await call(site(`${a.project.name}--${a.project.secret}--abc`), "GET", "/")).status).toBe(404);

    await call(APP, "PATCH", `/api/projects/${a.project.id}`, { cookie: a.cookie, body: { shared: true } });
    const shared = await call(open, "GET", "/");
    expect(shared.status).toBe(200);
    // The shared site is served exactly as written.
    expect(shared.text).toBe(await read(a.cookie, a.project.id, "index.html"));
    expect(shared.headers["x-robots-tag"]).toBe("noindex");
    expect(shared.headers["x-content-type-options"]).toBe("nosniff");
    expect(shared.headers["content-security-policy"]).toBeUndefined();
    expect(shared.headers["set-cookie"]).toBeUndefined();

    await call(APP, "PATCH", `/api/projects/${a.project.id}`, { cookie: a.cookie, body: { shared: false } });
    expect((await call(open, "GET", "/")).status).toBe(404);
  });

  test("files carry an ETag and answer 304 when unchanged", async () => {
    const a = await person("etag");
    const alias = site(`${a.project.name}--${a.project.secret}`);
    const first = await call(alias, "GET", "/style.css");
    expect(first.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(first.headers["cache-control"]).toBe("no-cache");
    const etag = String(first.headers.etag);
    const again = await call(alias, "GET", "/style.css", { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    await put(a.cookie, a.project.id, "style.css", "body { color: red; }");
    const changed = await call(alias, "GET", "/style.css", { headers: { "If-None-Match": etag } });
    expect(changed.status).toBe(200);
    expect(changed.text).toBe("body { color: red; }");
  });

  test("folders serve index.html, paths are case-sensitive, 404.html is used when present", async () => {
    const a = await person("paths");
    const alias = site(`${a.project.name}--${a.project.secret}`);
    await put(a.cookie, a.project.id, "about/index.html", "<!doctype html><p>about");
    expect((await call(alias, "GET", "/about/")).text).toContain("<p>about");
    expect((await call(alias, "GET", "/about")).status).toBe(302);
    expect((await call(alias, "GET", "/About/")).status).toBe(404);

    const missing = await call(alias, "GET", "/nope.html");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("/nope.html");
    await put(a.cookie, a.project.id, "404.html", "<!doctype html><p>own 404");
    const own = await call(alias, "GET", "/nope.html");
    expect(own.status).toBe(404);
    expect(own.text).toContain("own 404");
  });

  test("a range request returns part of a file", async () => {
    const a = await person("range");
    const alias = site(`${a.project.name}--${a.project.secret}`);
    await put(a.cookie, a.project.id, "notes.txt", "0123456789");
    const part = await call(alias, "GET", "/notes.txt", { headers: { Range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.text).toBe("2345");
    expect(part.headers["content-range"]).toBe("bytes 2-5/10");
  });

  test("the editor's own pages send a strict policy, and student files there are downloads", async () => {
    const a = await person("csp");
    const page = await call(APP, "GET", "/");
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const file = await call(APP, "GET", filesUrl(a.project.id, "index.html"), { cookie: a.cookie });
    expect(file.headers["content-type"]).toBe("application/octet-stream");
    expect(file.headers["content-disposition"]).toBe("attachment");
    expect(file.headers["content-security-policy"]).toBe("sandbox");
  });

  test("unknown hosts and reserved names answer 404", async () => {
    expect((await call(site("admin"), "GET", "/")).status).toBe(404);
    expect((await call("a.b.localhost:8787", "GET", "/")).status).toBe(404);
    expect((await call("www.localhost:8787", "GET", "/x")).status).toBe(301);
  });

  test("the site's own 404 page is set in Atkinson, loaded from the editor's host", async () => {
    const page = await call(site("nobody-here"), "GET", "/");
    const font = /url\("([^"]+\.woff2)"\)/.exec(page.text)?.[1];
    expect(font).toBe(`${ORIGIN}/fonts/atkinson-hyperlegible-next.woff2`);
    expect(page.text).toContain('font-family: "Atkinson Hyperlegible Next"');
    // A font from another origin loads only with CORS.
    const file = await call(APP, "GET", "/fonts/atkinson-hyperlegible-next.woff2");
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("font/woff2");
    expect(file.headers["access-control-allow-origin"]).toBe("*");
  });
});

test.describe("saving", () => {
  test("a save with the revision last seen succeeds, a stale one is refused", async () => {
    const a = await person("save");
    const rev = await revOf(a.cookie, a.project.id, "index.html");
    const saved = await put(a.cookie, a.project.id, "index.html", "<p>one", rev);
    expect(saved.status).toBe(200);
    expect(saved.json.rev).toBeGreaterThan(rev);

    const stale = await put(a.cookie, a.project.id, "index.html", "<p>from another tab", rev);
    expect(stale.status).toBe(412);
    expect(stale.json.rev).toBe(saved.json.rev);
    expect(await read(a.cookie, a.project.id, "index.html")).toBe("<p>one");

    // "Keep mine" sends the same text with the revision from the refusal.
    expect((await put(a.cookie, a.project.id, "index.html", "<p>mine", stale.json.rev)).status).toBe(200);
    // Creating with revision 0 fails when the file exists.
    expect((await put(a.cookie, a.project.id, "index.html", "x", 0)).status).toBe(412);
  });

  test("file types outside the allow-list and bad paths are refused", async () => {
    const a = await person("types");
    expect((await put(a.cookie, a.project.id, "virus.exe", "MZ")).json.error).toBe("type");
    expect((await put(a.cookie, a.project.id, "run.php", "<?php")).status).toBe(415);
    expect((await put(a.cookie, a.project.id, "../up.html", "x")).status).toBeGreaterThanOrEqual(400);
    expect((await call(APP, "PUT", `/api/projects/${a.project.id}/files/..%2Fup.html`, { cookie: a.cookie, body: "x" })).status).toBe(400);
    expect((await put(a.cookie, a.project.id, ".htaccess", "x")).json.error).toBe("path-leading-dot");
    expect((await put(a.cookie, a.project.id, "index.html/x.html", "x")).json.error).toBe("parent-is-file");
  });

  test("a file over 10 MB is refused", async () => {
    const a = await person("big");
    const big = await put(a.cookie, a.project.id, "big.jpg", Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
  });

  test("a form on a student site that posts to the API changes nothing", async () => {
    const a = await person("csrf");
    const before = await read(a.cookie, a.project.id, "index.html");
    const evil = `http://${site(a.project.name)}`;
    const url = `/api/projects/${a.project.id}`;
    const form = { "Content-Type": "application/x-www-form-urlencoded" };

    // What a form can send: the victim's cookie, its own Origin, a form content type.
    const attempts = [
      await call(APP, "POST", `${url}/move`, { cookie: a.cookie, noOrigin: true, headers: { Origin: evil, ...form }, body: Buffer.from("from=index.html&to=x.html") }),
      await call(APP, "POST", `${url}/move`, { cookie: a.cookie, noOrigin: true, headers: { Origin: evil }, body: { from: "index.html", to: "x.html" } }),
      await call(APP, "POST", `${url}/move`, { cookie: a.cookie, headers: { Origin: ORIGIN, "Content-Type": "text/plain" }, body: Buffer.from('{"from":"index.html","to":"x.html"}') }),
      await call(APP, "POST", `${url}/move`, { cookie: a.cookie, noOrigin: true, body: { from: "index.html", to: "x.html" } }),
      await call(APP, "DELETE", url, { cookie: a.cookie, noOrigin: true, headers: { Origin: evil } }),
      await call(APP, "PATCH", url, { cookie: a.cookie, noOrigin: true, headers: { Origin: "null" }, body: { shared: true } }),
      await call(APP, "POST", "/auth/logout", { cookie: a.cookie, noOrigin: true, headers: { Origin: evil, ...form } }),
    ];
    for (const attempt of attempts) expect(attempt.status).toBe(403);

    expect(await read(a.cookie, a.project.id, "index.html")).toBe(before);
    const project = await call(APP, "GET", url, { cookie: a.cookie });
    expect(project.json.project.shared).toBe(false);
    expect((await call(APP, "GET", "/api/me", { cookie: a.cookie })).json.user).not.toBeNull();
    // The API sends no CORS headers, so a script on a student site cannot read a reply either.
    expect(project.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

test.describe("another person's project", () => {
  test("a private project answers 404 to every action of someone else", async () => {
    const a = await person("owner");
    const b = await person("other");
    const url = `/api/projects/${a.project.id}`;
    const snaps = await call(APP, "GET", `${url}/snapshots`, { cookie: a.cookie });
    const sid = snaps.json.snapshots[0]?.id ?? "none";

    for (const who of [b.cookie, undefined]) {
      const actions = [
        await call(APP, "GET", url, { cookie: who }),
        await call(APP, "GET", `/api/projects/${a.project.name}`, { cookie: who }),
        await call(APP, "GET", `${url}/files`, { cookie: who }),
        await call(APP, "GET", `${url}/files/index.html`, { cookie: who }),
        await call(APP, "PUT", `${url}/files/index.html`, { cookie: who, body: "hacked" }),
        await call(APP, "PUT", `${url}/files/new?folder=1`, { cookie: who }),
        await call(APP, "DELETE", `${url}/files/index.html`, { cookie: who }),
        await call(APP, "POST", `${url}/move`, { cookie: who, body: { from: "index.html", to: "x.html" } }),
        await call(APP, "PATCH", url, { cookie: who, body: { shared: true } }),
        await call(APP, "PATCH", url, { cookie: who, body: { name: "stolen-name" } }),
        await call(APP, "DELETE", url, { cookie: who }),
        await call(APP, "GET", `${url}/snapshots`, { cookie: who }),
        await call(APP, "POST", `${url}/snapshots`, { cookie: who }),
        await call(APP, "POST", `${url}/snapshots/${sid}/restore`, { cookie: who }),
        await call(APP, "POST", `${url}/copy`, { cookie: who }),
      ];
      for (const action of actions) expect([401, 404]).toContain(action.status);
    }
    const mine = await call(APP, "GET", url, { cookie: a.cookie });
    expect(mine.json.project.name).toBe(a.project.name);
    expect(mine.json.project.shared).toBe(false);
    expect(await read(a.cookie, a.project.id, "index.html")).toContain("<h1>");
  });

  test("a shared project can be read and copied by someone else, and never changed", async () => {
    const a = await person("teacher");
    const b = await person("student");
    const url = `/api/projects/${a.project.name}`;
    await call(APP, "PATCH", url, { cookie: a.cookie, body: { shared: true } });

    const seen = await call(APP, "GET", url, { cookie: b.cookie });
    expect(seen.status).toBe(200);
    expect(seen.json.project.owner).toBe(false);
    // The preview secret stays with the owner.
    expect(seen.json.project.secret).toBeUndefined();
    expect((await call(APP, "GET", `${url}/files/index.html`, { cookie: b.cookie })).status).toBe(200);
    expect((await call(APP, "GET", `${url}/files/index.html`)).status).toBe(200);

    for (const write of [
      await call(APP, "PUT", `${url}/files/index.html`, { cookie: b.cookie, body: "hacked" }),
      await call(APP, "DELETE", `${url}/files/index.html`, { cookie: b.cookie }),
      await call(APP, "POST", `${url}/move`, { cookie: b.cookie, body: { from: "index.html", to: "x.html" } }),
      await call(APP, "PATCH", url, { cookie: b.cookie, body: { shared: false } }),
      await call(APP, "DELETE", url, { cookie: b.cookie }),
      await call(APP, "GET", `${url}/snapshots`, { cookie: b.cookie }),
    ]) {
      expect(write.status).toBe(404);
    }

    // The copy link gives a second account an independent copy.
    const copy = await call(APP, "POST", `${url}/copy`, { cookie: b.cookie });
    expect(copy.status).toBe(200);
    const mine = copy.json.project;
    expect(mine.name).not.toBe(a.project.name);
    expect(mine.owner).toBe(true);
    expect(mine.shared).toBe(false);
    await put(b.cookie, mine.id, "index.html", "<p>my own version");
    expect(await read(a.cookie, a.project.id, "index.html")).toContain("<h1>");
    await put(a.cookie, a.project.id, "index.html", "<p>teacher moved on");
    expect(await read(b.cookie, mine.id, "index.html")).toBe("<p>my own version");
    expect((await call(APP, "POST", `${url}/copy`)).status).toBe(401);
  });

  test("admin pages do not exist for a person who is not an admin", async () => {
    const b = await person("nosy");
    expect((await call(APP, "GET", "/api/admin/state", { cookie: b.cookie })).status).toBe(404);
    expect((await call(APP, "POST", "/api/admin/allowed", { cookie: b.cookie, body: { pattern: "evil.test" } })).status).toBe(404);
    expect((await call(APP, "POST", "/api/admin/invites", { cookie: b.cookie, body: {} })).status).toBe(404);
    expect((await call(APP, "GET", "/api/admin/state")).status).toBe(404);
  });
});

test.describe("files", () => {
  test("renaming to images/cat.jpg moves the file and creates the folder", async () => {
    const a = await person("move");
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect((await put(a.cookie, a.project.id, "cat.jpg", jpg)).status).toBe(200);
    const moved = await call(APP, "POST", `/api/projects/${a.project.id}/move`, { cookie: a.cookie, body: { from: "cat.jpg", to: "images/cat.jpg" } });
    expect(moved.status).toBe(200);
    const files = (await call(APP, "GET", filesUrl(a.project.id), { cookie: a.cookie })).json.files;
    expect(files.find((f: any) => f.path === "images").kind).toBe("folder");
    expect(files.find((f: any) => f.path === "cat.jpg")).toBeUndefined();

    const alias = site(`${a.project.name}--${a.project.secret}`);
    const served = await call(alias, "GET", "/images/cat.jpg");
    expect(served.headers["content-type"]).toBe("image/jpeg");
    expect(served.bytes.equals(jpg)).toBe(true);
    expect((await call(alias, "GET", "/cat.jpg")).status).toBe(404);
  });

  test("a folder moves with everything in it, and never into itself or over a file", async () => {
    const a = await person("folder");
    const url = `/api/projects/${a.project.id}`;
    await put(a.cookie, a.project.id, "img/a/one.txt", "1");
    await put(a.cookie, a.project.id, "img/two.txt", "2");
    await put(a.cookie, a.project.id, "img2/keep.txt", "k");
    expect((await call(APP, "POST", `${url}/move`, { cookie: a.cookie, body: { from: "img", to: "img/sub" } })).status).toBe(400);
    expect((await call(APP, "POST", `${url}/move`, { cookie: a.cookie, body: { from: "img", to: "index.html" } })).status).toBe(409);
    expect((await call(APP, "POST", `${url}/move`, { cookie: a.cookie, body: { from: "img", to: "media/pictures" } })).status).toBe(200);
    const paths = (await call(APP, "GET", `${url}/files`, { cookie: a.cookie })).json.files.map((f: any) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["media", "media/pictures", "media/pictures/a", "media/pictures/a/one.txt", "media/pictures/two.txt", "img2/keep.txt"]));
    expect(paths).not.toContain("img");
    expect(paths).not.toContain("img/two.txt");
  });

  test("an empty folder survives, and deleting a folder takes its files", async () => {
    const a = await person("empty");
    const url = `/api/projects/${a.project.id}`;
    expect((await call(APP, "PUT", `${url}/files/leeg?folder=1`, { cookie: a.cookie })).status).toBe(200);
    await put(a.cookie, a.project.id, "docs/a.txt", "a");
    await put(a.cookie, a.project.id, "docs/b.txt", "b");
    let files = (await call(APP, "GET", `${url}/files`, { cookie: a.cookie })).json.files;
    expect(files.find((f: any) => f.path === "leeg").kind).toBe("folder");
    const gone = await call(APP, "DELETE", `${url}/files/docs`, { cookie: a.cookie });
    expect(gone.json.deleted).toBe(3);
    files = (await call(APP, "GET", `${url}/files`, { cookie: a.cookie })).json.files;
    expect(files.map((f: any) => f.path)).not.toContain("docs/a.txt");
  });
});

test.describe("history", () => {
  test("an emptied index.html comes back with Restore, and the restore can be undone", async () => {
    const a = await person("history");
    const url = `/api/projects/${a.project.id}`;
    const original = await read(a.cookie, a.project.id, "index.html");
    // Opening a project takes a snapshot.
    expect((await call(APP, "POST", `${url}/snapshots`, { cookie: a.cookie })).json.id).toBeTruthy();
    await put(a.cookie, a.project.id, "index.html", "");
    await call(APP, "DELETE", `${url}/files/style.css`, { cookie: a.cookie });

    const list = (await call(APP, "GET", `${url}/snapshots`, { cookie: a.cookie })).json.snapshots;
    const first = list[list.length - 1];
    expect(first.changed).toBe(2);

    // A snapshot can be looked at before it is restored.
    const old = await call(site(`0--${a.project.secret}--${first.id}`), "GET", "/");
    expect(old.text).toContain("<h1>");
    expect((await call(site(`0--${a.project.secret}--${first.id}`), "GET", "/style.css")).status).toBe(200);

    const restored = await call(APP, "POST", `${url}/snapshots/${first.id}/restore`, { cookie: a.cookie });
    expect(restored.status).toBe(200);
    expect(await read(a.cookie, a.project.id, "index.html")).toBe(original);
    expect(restored.json.files.map((f: any) => f.path)).toContain("style.css");

    const after = (await call(APP, "GET", `${url}/snapshots`, { cookie: a.cookie })).json.snapshots;
    expect(after.length).toBeGreaterThan(list.length);
    await call(APP, "POST", `${url}/snapshots/${after[0].id}/restore`, { cookie: a.cookie });
    expect(await read(a.cookie, a.project.id, "index.html")).toBe("");
  });

  test("a restore makes a save from a stale tab conflict", async () => {
    const a = await person("stale");
    const url = `/api/projects/${a.project.id}`;
    const snap = await call(APP, "POST", `${url}/snapshots`, { cookie: a.cookie });
    const rev = await revOf(a.cookie, a.project.id, "index.html");
    await call(APP, "POST", `${url}/snapshots/${snap.json.id}/restore`, { cookie: a.cookie });
    expect((await put(a.cookie, a.project.id, "index.html", "stale", rev)).status).toBe(412);
  });
});

test.describe("projects", () => {
  test("renaming changes the address and the old name redirects", async () => {
    const a = await person("rename");
    const url = `/api/projects/${a.project.id}`;
    const fresh = `nieuwe-naam-${Math.random().toString(36).slice(2, 8)}`;
    await call(APP, "PATCH", url, { cookie: a.cookie, body: { shared: true } });
    expect((await call(APP, "PATCH", url, { cookie: a.cookie, body: { name: "admin" } })).json.error).toBe("name-reserved");
    expect((await call(APP, "PATCH", url, { cookie: a.cookie, body: { name: "Bad Name" } })).json.error).toBe("name-chars");
    const b = await person("taken");
    expect((await call(APP, "PATCH", url, { cookie: a.cookie, body: { name: b.project.name } })).json.error).toBe("name-taken");

    expect((await call(APP, "PATCH", url, { cookie: a.cookie, body: { name: fresh } })).json.project.name).toBe(fresh);
    expect((await call(site(fresh), "GET", "/")).status).toBe(200);
    const old = await call(site(a.project.name), "GET", "/style.css");
    expect(old.status).toBe(302);
    expect(old.headers.location).toBe(`http://${site(fresh)}/style.css`);
    // Nobody else can take the old name while it redirects.
    expect((await call(APP, "PATCH", `/api/projects/${b.project.id}`, { cookie: b.cookie, body: { name: a.project.name } })).json.error).toBe("name-taken");
  });

  test("a deleted project goes to the trash, goes offline, and can come back", async () => {
    const a = await person("trash");
    const url = `/api/projects/${a.project.id}`;
    await call(APP, "PATCH", url, { cookie: a.cookie, body: { shared: true } });
    expect((await call(APP, "DELETE", url, { cookie: a.cookie })).status).toBe(200);
    expect((await call(site(a.project.name), "GET", "/")).status).toBe(404);
    expect((await call(APP, "GET", url, { cookie: a.cookie })).status).toBe(404);
    const list = await call(APP, "GET", "/api/projects", { cookie: a.cookie });
    expect(list.json.projects.map((p: any) => p.id)).not.toContain(a.project.id);
    const trash = await call(APP, "GET", "/api/projects?trash=1", { cookie: a.cookie });
    expect(trash.json.projects.map((p: any) => p.id)).toContain(a.project.id);

    await call(APP, "PATCH", url, { cookie: a.cookie, body: { trashed: false } });
    expect((await call(APP, "GET", url, { cookie: a.cookie })).status).toBe(200);
    expect(await read(a.cookie, a.project.id, "index.html")).toContain("<h1>");
  });

  test("resetting the preview link makes the old alias stop working", async () => {
    const a = await person("secret");
    const old = site(`${a.project.name}--${a.project.secret}`);
    expect((await call(old, "GET", "/")).status).toBe(200);
    const reset = await call(APP, "PATCH", `/api/projects/${a.project.id}`, { cookie: a.cookie, body: { resetSecret: true } });
    expect(reset.json.project.secret).not.toBe(a.project.secret);
    expect((await call(old, "GET", "/")).status).toBe(404);
  });

  test("a report reaches the admin, who blocks the site with a reason the owner sees", async () => {
    const admin = await setUp();
    const a = await person("reported");
    const url = `/api/projects/${a.project.id}`;
    await call(APP, "PATCH", url, { cookie: a.cookie, body: { shared: true } });
    expect((await call(APP, "POST", "/api/reports", { body: { name: a.project.name, reason: "phishing page" } })).status).toBe(200);
    expect((await call(APP, "POST", "/api/reports", { body: { name: a.project.name, reason: "" } })).status).toBe(400);
    const state = await call(APP, "GET", "/api/admin/state", { cookie: admin.cookie });
    const report = state.json.reports.find((r: any) => r.project_name === a.project.name);
    expect(report.reason).toBe("phishing page");

    const target = `/api/admin/projects/${a.project.name}`;
    const looked = await call(APP, "GET", target, { cookie: admin.cookie });
    expect(looked.json.project.owner).toBe(a.email);
    expect((await call(APP, "POST", target, { cookie: admin.cookie, body: { block: true } })).status).toBe(400);
    await call(APP, "POST", target, { cookie: admin.cookie, body: { block: true, reason: "Asks for passwords." } });
    expect((await call(site(a.project.name), "GET", "/")).status).toBe(404);

    // The owner keeps the project, sees why, and cannot share it again.
    const own = await call(APP, "GET", url, { cookie: a.cookie });
    expect(own.json.project.blocked).toBe("Asks for passwords.");
    expect((await call(APP, "PATCH", url, { cookie: a.cookie, body: { shared: true } })).json.error).toBe("blocked");
    const after = await call(APP, "GET", "/api/admin/state", { cookie: admin.cookie });
    expect(after.json.reports.find((r: any) => r.id === report.id).handled_at).not.toBeNull();
    expect(after.json.moderation[0]).toMatchObject({ action: "block", target: a.project.name, reason: "Asks for passwords." });

    await call(APP, "POST", target, { cookie: admin.cookie, body: { block: false } });
    expect((await call(APP, "PATCH", url, { cookie: a.cookie, body: { shared: true } })).status).toBe(200);
    expect((await call(site(a.project.name), "GET", "/")).status).toBe(200);
  });

  test("a suspended person is signed out, cannot sign in, and their sites go offline until restored", async () => {
    const admin = await setUp();
    const a = await person("suspended");
    await call(APP, "PATCH", `/api/projects/${a.project.id}`, { cookie: a.cookie, body: { shared: true } });
    const alias = site(`${a.project.name}--${a.project.secret}`);
    const found = await call(APP, "GET", `/api/admin/people?q=${encodeURIComponent(a.email)}`, { cookie: admin.cookie });
    const id = found.json.people[0].id;
    expect(found.json.people[0].projects).toBe(1);

    await call(APP, "POST", `/api/admin/people/${id}`, { cookie: admin.cookie, body: { suspend: true, reason: "Spam." } });
    expect((await call(APP, "GET", "/api/me", { cookie: a.cookie })).json.user).toBeNull();
    expect((await signIn(a.email)).location).toBe("/?refused=suspended");
    expect((await call(site(a.project.name), "GET", "/")).status).toBe(404);
    expect((await call(alias, "GET", "/")).status).toBe(404);
    expect((await call(APP, "GET", `/api/projects/${a.project.name}`)).status).toBe(404);

    await call(APP, "POST", `/api/admin/people/${id}`, { cookie: admin.cookie, body: { suspend: false } });
    expect((await signIn(a.email)).cookie).toContain("__Host-session=");
    expect((await call(site(a.project.name), "GET", "/")).status).toBe(200);
  });

  test("an admin cannot be suspended, and nobody else reaches the moderation routes", async () => {
    const admin = await setUp();
    const me = await call(APP, "GET", "/api/admin/people?q=admin@school.test", { cookie: admin.cookie });
    const reply = await call(APP, "POST", `/api/admin/people/${me.json.people[0].id}`, {
      cookie: admin.cookie,
      body: { suspend: true, reason: "test" },
    });
    expect(reply.status).toBe(409);
    const a = await person("nosy");
    expect((await call(APP, "GET", "/api/admin/people", { cookie: a.cookie })).status).toBe(404);
    expect((await call(APP, "POST", `/api/admin/projects/${a.project.name}`, { cookie: a.cookie, body: { block: true, reason: "x" } })).status).toBe(404);
  });

  test("the version endpoint says which build is live", async () => {
    const v = await call(APP, "GET", "/api/version");
    expect(v.status).toBe(200);
    expect(v.json.commit).toBe("dev");
  });

  test("removing an allow-list entry ends the sessions it covered", async () => {
    const admin = await setUp();
    await call(APP, "POST", "/api/admin/allowed", { cookie: admin.cookie, body: { pattern: "workshop.test" } });
    const guest = await signIn("guest@workshop.test");
    expect((await call(APP, "GET", "/api/me", { cookie: guest.cookie })).json.user.email).toBe("guest@workshop.test");
    await call(APP, "DELETE", "/api/admin/allowed", { cookie: admin.cookie, body: { pattern: "workshop.test" } });
    expect((await call(APP, "GET", "/api/me", { cookie: guest.cookie })).json.user).toBeNull();
    expect((await signIn("guest@workshop.test")).location).toBe("/?refused=invite");
    // The admin and people on other entries are untouched.
    expect((await call(APP, "GET", "/api/me", { cookie: admin.cookie })).json.user).not.toBeNull();
  });

  test("the weekly cleanup runs and leaves files in use alone", async () => {
    const a = await person("cleanup");
    // Wrangler's local trigger answers "ok" when the scheduled handler returned without an error.
    const ran = await call(APP, "GET", "/cdn-cgi/local/scheduled");
    expect(ran.text.trim()).toBe("ok");
    expect((await call(site(`${a.project.name}--${a.project.secret}`), "GET", "/")).status).toBe(200);
    expect((await call(APP, "GET", "/api/me", { cookie: a.cookie })).json.user).not.toBeNull();
  });

  test("deleting an account needs the typed address and removes everything", async () => {
    const a = await person("leave");
    await call(APP, "PATCH", `/api/projects/${a.project.id}`, { cookie: a.cookie, body: { shared: true } });
    expect((await call(APP, "DELETE", "/api/me", { cookie: a.cookie, body: { confirm: "yes" } })).status).toBe(400);
    expect((await call(APP, "DELETE", "/api/me", { cookie: a.cookie, body: { confirm: a.email } })).status).toBe(200);
    expect((await call(site(a.project.name), "GET", "/")).status).toBe(404);
    expect((await call(APP, "GET", "/api/me", { cookie: a.cookie })).json.user).toBeNull();
  });
});
