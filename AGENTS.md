# maak.io

A browser editor where a student writes a multi-file website and sees it live at `name.<site suffix>`.
One Cloudflare Worker, one D1 database, one R2 bucket. Student code is stored and served, never run on the server.

## Commands

- Verify: `npm test` (type check, build, then Playwright: rules, API over HTTP, editor in Chromium). Needs `npx playwright install chromium` once.
- Develop: `npm run dev`, then open http://localhost:8787. Sign-in goes to a local provider on :8788 that accepts any address. `admin@school.test` is the admin.
- Deploy: `npm test && npm run deploy` (`scripts/deploy.mjs`: build, migrations, deploy with `COMMIT`, smoke test, rollback if the smoke test fails). A migration is not rolled back, so it must keep working with the code before it. The top level of `wrangler.jsonc` is local development; `env.production` is the live site.
- CI: `.github/workflows/deploy.yml` tests every push and pull request and deploys a push to `main`. It needs the secret `CLOUDFLARE_API_TOKEN` in the GitHub environment `production`. `uptime.yml` runs `scripts/smoke.mjs` every 30 minutes; GitHub mails the owner on failure.
- Live version: `https://maak.io/api/version` gives the commit (`-dirty` for a deploy from uncommitted work) and the Worker version id for `wrangler rollback`.
- Backup: `npm run backup` writes the database and every file it points at to `~/Backups/maak` (fetches only new files). `scripts/restore.mjs <backup>` restores into `.wrangler/restore`; `node scripts/dev.mjs --state .wrangler/restore` serves it. Rehearsed 14 November 2026: the restored files matched production byte for byte. D1 Time Travel covers the last 7 days on the free plan.
- Repository: https://github.com/fdb/maak, public. Base branch `main`. Branch policy: not recorded.

## Production

- Cloudflare account Enigmeta. Worker `maak` on routes `maak.io/*` and `*.maak.io/*`, D1 `maak` (location hint Western Europe), R2 `maak-files` (EU jurisdiction).
- Sign-in is Google, OAuth client `maak.io web` in the Google Cloud project `maakio`, redirect `https://maak.io/auth/callback`.
- Secrets, set with `npx wrangler secret put <NAME> --env production`: `OIDC_CLIENT_SECRET`, `ADMIN_EMAILS` (comma-separated). `CONTACT` is a plain variable in `wrangler.jsonc`. Without `ADMIN_EMAILS` and an allow-list entry nobody can sign in.
- Mail: Cloudflare Email Routing forwards `info@maak.io` to the owner. `CONTACT` shows that address on the about and privacy pages. Each report sends a note to `ADMIN_EMAILS` through the `send_email` binding `MAIL`, from `MAIL_FROM` (`reports@mail.maak.io`), which needs `mail.maak.io` onboarded to Cloudflare Email Sending. Locally the mail is simulated and printed. A failed send is logged; the report is stored either way.
- DNS: a proxied wildcard record `*` (A 192.0.2.1, a placeholder) sends every `name.maak.io` to the Worker. `staging.maak.io` is a DNS-only record to another server and is a reserved project name.

## Look

- One grid of panels that share single lines; no panel has its own border. Box headers are a small label, not a bar. The three column headers share one height.
- No button has an outline. A button is an icon and a word with a soft fill on hover; Share is the one filled button. An action that explains itself is an icon with a tooltip (new file, new folder, reload, more); one that does not carries its word (Upload, Open). Download ZIP is in the editor's More menu.
- The editor bar is one line on a wide screen. On a phone it is two: maak, then the save status and the theme on the right; below, the address, then Share and More on the right (CSS `order` in `style.css`).
- Icons are Lucide (`lucide-preact`, ISC), imported by name so only the used ones ship.
- Atkinson Hyperlegible Next for the interface, JetBrains Mono for code, both self-hosted from `@fontsource-variable` (OFL). The editor loads nothing from another party; a test checks this.
- Colours are CSS variables in `web/src/style.css`, with a dark set under `:root[data-theme="dark"]`. The code editor reads the same variables, so a theme needs no editor code. Code ligatures are off on purpose.
- The preview frame stays white in dark mode: the student's page decides its own colours.

## Code editor

- Emmet is on for HTML only, on Tab, and guarded (`expandOnTab` in `web/src/cm.ts`): it expands only when the abbreviation starts with a real HTML tag, `.class`, `#id` or `!`, and the cursor is in page text. Without the guard Emmet turns any word into a tag. The spec had Emmet off; this was a later decision.
- An image dropped on HTML code becomes `<img src alt>` at that spot, with a path relative to the HTML file. From the computer it is uploaded next to that file first.
- Opening an HTML file (tree, dropdown, new file, duplicate) also shows that page in the preview.

## Project list

- Each project in the list shows its own page, small, in a frame on the private alias with an empty `sandbox`. No script of the student runs in the list, so a page that hangs or plays sound cannot do so there. A page that builds itself with JavaScript shows only its HTML and CSS.
- Download all and delete account are on `/account`. Sign out is the last item of the account menu.

## Moderation

- An admin blocks a project with a reason: sharing goes off, the owner cannot switch it on again, and sees the reason in the list and the editor. Blocking marks that project's open reports as handled.
- An admin suspends a person with a reason: their sessions end, sign-in is refused (`/?refused=suspended`), and their sites, previews and shared code answer 404. Lifting it restores all of that. Admins cannot be suspended.
- Every block, unblock, suspension and restore goes into the `moderation` table with the admin and the reason, shown as the log on `/admin`.

## Uploads

- Every upload starts in `store.offer`. Images over 1920 px on the longest side or over 1 MB open a dialog with four sizes and "keep the original". The resize runs in the browser (`web/src/resize.ts`), and only the resized file is sent, so the bucket never holds the large one. One answer covers the whole batch.

## Layout

- `src/worker/index.ts` routes by host name: `APP_HOST` is the editor and API, `<name>.<SITE_SUFFIX>` a shared site, `<name>--<secret>.<SITE_SUFFIX>` the preview alias.
- `src/worker/app.ts` API and sign-in routes. `auth.ts` OpenID Connect. `projects.ts` files, snapshots, copy, cleanup. `sites.ts` serving. `helper.ts` the script injected into alias HTML.
- `src/shared/rules.ts` names, paths, content types, limits. The Worker enforces them and the editor shows them.
- `web/src` the editor (Preact, CodeMirror 6). `store.ts` holds the open project and the save pipeline. `i18n.ts` holds every interface text in Dutch and English.
- `scripts/dev-idp.mjs` the local sign-in provider. It signs in anyone, so it binds to 127.0.0.1 only.
- `experiments/` the two browser experiments behind the preview design.

## Rules that are easy to break

- One domain or two is configuration: `APP_HOST` and `SITE_SUFFIX`. No code may assume they are equal.
- Every write to the API needs `Origin` equal to the editor's origin and a JSON or octet-stream content type. A student site is same-site with the editor, so cookies alone protect nothing.
- A project the caller may not see answers 404, never 403.
- Student files fetched through the API are sent as `application/octet-stream` with `Content-Security-Policy: sandbox`. Nothing a student wrote may render on the editor's origin.
- The helper script exists only in alias HTML responses. It must add no line to the document, or line numbers in the console strip go wrong. It is sent as one `eval` string for that reason.
- Wrangler's bundler wraps named functions in `__name(...)`. Code that is turned into a string for the page (`helperSource.toString()`) must define `__name` itself.
- The Worker refuses a plain-http `OIDC_ISSUER` unless `APP_HOST` is `localhost:<port>`. There is no test-only sign-in switch.
- Revisions come from one counter per project (`projects.rev_seq`), so a file that is deleted and created again never reuses a number.

## Measured, 13 November 2026 (Chrome and Chromium on macOS)

- A page that hangs in the preview freezes an editor on the same site. `Origin-Agent-Cluster: ?1` on the student site's responses prevents that. Two registrable domains prevent it too. Run `OAC=1 CHANNEL=chrome node experiments/hung-iframe.mjs`.
- A hung preview keeps its browser process stuck for the life of the tab, and every new frame on that origin gets the same stuck process. With the header, another host name gets a fresh process. This is why the alias has numbered twins (`name--secret--2`) and why "Start preview" moves to the next one. Run `OAC=1 CHANNEL=chrome node experiments/hung-recovery.mjs`.
- Playwright's default headless shell has no site isolation: the editor freezes in every setup. The tests use `channel: "chromium"`.
- While a frame's process hangs, Playwright's keyboard and mouse calls stall. One test edits from inside the page for that reason. Not verified: whether a real keyboard is held up the same way.
- The editor script is 246 kB gzipped, CodeMirror and Emmet included (Emmet adds about 38 kB). Fonts load as separate files.
- Not measured: Firefox and Safari (hung preview, `alert()` in the preview frame), and save-to-reload time on school wifi.

## Open

- The terms and privacy pages are drafts, marked as such on the page. The legal questions in the spec are not settled.
- On the Workers free plan a request may make 50 subrequests. Copying a project with more than about 25 distinct files needs the paid plan.
