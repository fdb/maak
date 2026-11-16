# maak

A browser editor where a student writes their first website and sees it live at its own address. It runs at [maak.io](https://maak.io).

![The maak editor: a file list, the HTML and CSS of a page, and the page itself in the preview](.github/editor.png)

A student signs in, gets a project with a name like `gele-maan`, and edits HTML, CSS and JavaScript in several files. The preview on the right reloads on every save. Share switches the site on at `gele-maan.maak.io`, where anyone can open it.

The editor is for a first lesson in making web pages. It has Emmet for HTML, drag-and-drop of images into the code, a console strip under the preview, history of each file for 30 days, a trash, and a ZIP download of a project or of everything a person made. The interface is in Dutch and English.

## How it works

maak is one Cloudflare Worker, one D1 database and one R2 bucket. Student code is stored and served, never run on the server.

The Worker routes by host name. The editor and its API live on one host. Each shared project is a subdomain of the site suffix, and each project also has a private alias with a secret in its name, which the preview frames. The editor and the student sites can live on one domain or on two; that is configuration (`APP_HOST` and `SITE_SUFFIX`).

A page that hangs in the preview must not freeze the editor. The student sites send `Origin-Agent-Cluster: ?1`, which gives them their own browser process, and "Start preview" moves to a fresh alias host when a page is stuck. The two experiments in [`experiments/`](experiments) measure this in Chrome.

Sign-in is OpenID Connect; maak.io uses Google. An admin page lets a teacher block a project, suspend a person, and close sign-up.

## Run it locally

You need Node.js 22.12 or later.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:8787. Sign-in goes to a local provider on port 8788 that accepts any address without a password. `admin@school.test` is the admin. The local database and files are kept in `.wrangler/state`.

## Test

```bash
npx playwright install chromium
```

```bash
npm test
```

This type checks, builds, and runs the Playwright tests: the rules, the API over HTTP, and the editor in Chromium.

## Run your own

The top level of [`wrangler.jsonc`](wrangler.jsonc) is local development. `env.production` is the live maak.io. To run your own copy, replace the values there with yours:

- A Cloudflare account with a zone for your domain, a D1 database and an R2 bucket.
- Routes for the domain and its wildcard, and a proxied wildcard DNS record (`*`) so every subdomain reaches the Worker.
- An OpenID Connect client (for example Google), with the redirect `https://<your host>/auth/callback`.
- The secrets `OIDC_CLIENT_SECRET` and `ADMIN_EMAILS`, set with `npx wrangler secret put <NAME> --env production`.
- Optionally, Cloudflare Email Sending for the address in `MAIL_FROM`, so admins get a mail when someone reports a site.

Then deploy with `npm test && npm run deploy`. The deploy script builds, applies the migrations, deploys, runs a smoke test, and rolls back if the smoke test fails.

The limits per person (5 MB per file, 25 MB per project, 20 projects, 100 MB in all) are in [`src/shared/rules.ts`](src/shared/rules.ts).

## Layout

- `src/worker` the Worker: routing, the API, sign-in, file storage and serving the sites.
- `src/shared/rules.ts` names, paths, content types and limits, shared by the Worker and the editor.
- `web/src` the editor, in Preact and CodeMirror 6.
- `migrations` the D1 schema.
- `scripts` local development, deploy, smoke test, backup and restore.
- `tests` the Playwright tests.

[`AGENTS.md`](AGENTS.md) records the design decisions and the rules that are easy to break.

## License

MIT, see [LICENSE](LICENSE). The fonts (Atkinson Hyperlegible Next, JetBrains Mono) are under the SIL Open Font License and the icons (Lucide) under the ISC License; they come in through npm with their own licence files.
