// Every screen except the editor: front page, project list, trash, copy link, report, admin, text pages.

import { Download, FileCode, FileImage, FolderOpen, Globe, History, Palette } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ApiError, type Me, type ProjectInfo, api } from "./api";
import { type Lang, errorText, getLang, t, when } from "./i18n";
import { ThemeToggle } from "./look";
import { A, CopyButton, Menu, go, loadPart } from "./ui";

function Footer() {
  return (
    <footer class="foot">
      <A href="/about">{t("foot.about")}</A>
      <A href="/terms">{t("foot.terms")}</A>
      <A href="/privacy">{t("foot.privacy")}</A>
      <A href="/report">{t("foot.report")}</A>
    </footer>
  );
}

function Shell(props: { children: ComponentChildren; right?: ComponentChildren; wide?: boolean }) {
  return (
    <div class="shell">
      <header class="bar">
        <A href="/" class="home">
          maak
        </A>
        <span class="grow" />
        {props.right}
        <ThemeToggle />
      </header>
      <main class={props.wide ? "page page-wide" : "page"}>{props.children}</main>
      <Footer />
    </div>
  );
}

function ErrorLine(props: { code: string | null }) {
  return props.code ? (
    <p class="error" role="alert">
      {errorText(props.code)}
    </p>
  ) : null;
}

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "server");

interface LangProps {
  lang: Lang;
  onLang: (lang: Lang) => void;
}

/** One box of the demo: the code editor of the real editor, on text that is never saved. */
function DemoBox(props: { path: string; text: string; onChange: (text: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const change = useRef(props.onChange);
  change.current = props.onChange;
  useEffect(() => {
    // CodeMirror is most of the editor's script, so the front page fetches it after it shows.
    let view: { destroy(): void } | null = null;
    let gone = false;
    void loadPart(() => import("./cm")).then(({ EditorView, makeState }) => {
      if (gone) return;
      view = new EditorView({
        parent: host.current!,
        state: makeState(props.path, props.text, false, props.path, (text) => change.current(text)),
      });
    });
    return () => {
      gone = true;
      view?.destroy();
    };
  }, []);
  return <div class="demo-code" ref={host} />;
}

/**
 * A small editor on the front page, made of HTML so it follows the theme and the language. The two
 * boxes are real code boxes and the page on the right follows what is typed. Nothing is saved.
 * The page is a frame with an empty sandbox, so no script runs and nothing typed here can reach
 * the editor's origin.
 */
function Demo(props: { suffix: string }) {
  const [html, setHtml] = useState(
    () =>
      `<h1>${t("front.demo.h1")}</h1>\n<p>${t("front.demo.p")}</p>\n<a href="${t("front.demo.page")}">${t("front.demo.a")}</a>`,
  );
  const [css, setCss] = useState("body {\n  font-family: Georgia;\n  background: lemonchiffon;\n}\nh1 {\n  color: tomato;\n}");
  const page = `<!doctype html><meta charset="utf-8"><style>${css}</style>${html}`;
  return (
    <div class="demo" role="group" aria-label={t("front.demo")}>
      <div class="demo-files">
        <div class="demo-label">{t("front.demo.files")}</div>
        <div class="demo-file on">
          <FileCode size={15} />
          index.html
        </div>
        <div class="demo-file">
          <FileCode size={15} />
          {t("front.demo.page")}
        </div>
        <div class="demo-file">
          <Palette size={15} />
          style.css
        </div>
        <div class="demo-file">
          <FileImage size={15} />
          {t("front.demo.image")}
        </div>
      </div>
      <div class="demo-boxes">
        <div class="demo-label">
          <span class="kind kind-html" />
          index.html
        </div>
        <DemoBox path="index.html" text={html} onChange={setHtml} />
        <div class="demo-label demo-second">
          <span class="kind kind-css" />
          style.css
        </div>
        <DemoBox path="style.css" text={css} onChange={setCss} />
      </div>
      <div class="demo-preview">
        <div class="demo-label">
          {t("front.demo.preview")}
          <span class="demo-address">
            {t("front.demo.site")}.{props.suffix}
          </span>
        </div>
        <iframe class="demo-page" sandbox="" srcdoc={page} title={t("front.demo.preview")} />
      </div>
    </div>
  );
}

/** The signed-out front page: what maak is, a picture of it, and the way in. */
export function Front(props: { me: Me; next: string } & LangProps) {
  const query = new URLSearchParams(location.search);
  const refused = query.get("refused");
  const invite = query.get("invite");
  const login = new URLSearchParams({ next: props.next === "/projects" ? "/" : props.next });
  if (invite) login.set("invite", invite);
  const other = props.lang === "nl" ? "en" : "nl";
  const points = [
    { icon: <FolderOpen size={20} />, title: t("front.files.title"), text: t("front.files.text") },
    { icon: <Globe size={20} />, title: t("front.address.title"), text: t("front.address.text", { suffix: props.me.siteSuffix }) },
    { icon: <History size={20} />, title: t("front.history.title"), text: t("front.history.text") },
    { icon: <Download size={20} />, title: t("front.yours.title"), text: t("front.yours.text") },
  ];
  return (
    <Shell
      wide
      right={
        <button type="button" class="link" lang={other} onClick={() => props.onLang(other)}>
          {t("account.language")}
        </button>
      }
    >
      <div class="front">
        <h1>{t("front.line")}</h1>
        <p class="front-sub">{t("front.sub")}</p>
        {refused && (
          <p class="error" role="alert">
            {t(
              refused === "invite"
                ? "front.refused.invite"
                : refused === "email"
                  ? "front.refused.email"
                  : refused === "suspended"
                    ? "front.refused.suspended"
                    : refused === "busy"
                      ? "front.refused.busy"
                      : "front.refused.other",
            )}{" "}
            {t("front.contact", { contact: props.me.contact })}
          </p>
        )}
        {invite && !refused && <p>{t("front.invited")}</p>}
        <p class="front-go">
          <a class="button accent big" href={`/auth/login?${login}`}>
            {t("front.signIn")}
          </a>
          <A href="/about">{t("front.about")}</A>
        </p>
        {!invite && !refused && props.me.signup === "closed" && <p class="dim front-note">{t("front.invite")}</p>}
      </div>
      <Demo key={props.lang} suffix={props.me.siteSuffix} />
      <ul class="points">
        {points.map((point) => (
          <li>
            {point.icon}
            <h2>{point.title}</h2>
            <p>{point.text}</p>
          </li>
        ))}
      </ul>
      <section class="free">
        <h2>{t("front.free.title")}</h2>
        <p>{t("front.free.text")}</p>
      </section>
    </Shell>
  );
}

/** The menu behind the email address. Sign out is the last item on every page. */
function AccountMenu(props: { me: Me } & LangProps) {
  const user = props.me.user!;
  return (
    <Menu
      label={user.email}
      title={t("account.menu")}
      class="link"
      items={[
        { label: t("account.language"), run: () => props.onLang(props.lang === "nl" ? "en" : "nl") },
        { label: t("account.menu"), run: () => go("/account") },
        ...(user.admin ? [{ label: t("account.admin"), run: () => go("/admin") }] : []),
        {
          label: t("account.signOut"),
          run: async () => {
            await api("POST", "/auth/logout").catch(() => null);
            location.href = "/";
          },
        },
      ]}
    />
  );
}

/** The account page: who is signed in, the export of all work, and the way out. */
export function Account(props: { me: Me } & LangProps) {
  const [error, setError] = useState<string | null>(null);
  const user = props.me.user!;
  return (
    <Shell right={<AccountMenu {...props} />}>
      <h1>{t("account.menu")}</h1>
      <p>{t("account.signedIn", { email: user.email })}</p>
      <ErrorLine code={error} />
      <h2>{t("account.downloadAll")}</h2>
      <p class="dim">{t("account.downloadText")}</p>
      <p>
        <button type="button" class="button" onClick={() => void loadPart(() => import("./zip")).then((zip) => zip.downloadAll()).catch((e) => setError(codeOf(e)))}>
          <Download size={16} />
          {t("account.downloadAll")}
        </button>
      </p>
      <Leave email={user.email} />
      <p class="below">
        <A href="/">{t("app.back")}</A>
      </p>
    </Shell>
  );
}

export function Projects(props: { me: Me; trash: boolean } & LangProps) {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const load = () =>
    api<{ projects: ProjectInfo[] }>("GET", `/api/projects${props.trash ? "?trash=1" : ""}`)
      .then((r) => setProjects(r.projects))
      .catch((e) => setError(codeOf(e)));
  useEffect(() => {
    setProjects(null);
    void load();
  }, [props.trash]);

  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      await load();
    } catch (e) {
      setError(codeOf(e));
    }
  };

  // New project asks nothing: it creates a project with a generated name and opens it.
  const create = () =>
    act(async () => {
      const { project } = await api<{ project: ProjectInfo }>("POST", "/api/projects");
      go(`/e/${project.name}`);
    });

  const account = <AccountMenu me={props.me} lang={props.lang} onLang={props.onLang} />;

  return (
    <Shell right={account} wide={!props.trash}>
      <div class="list-head">
        <h1>{t(props.trash ? "trash.title" : "list.title")}</h1>
        {!props.trash && (
          <button type="button" class="button accent" onClick={create}>
            {t("list.new")}
          </button>
        )}
      </div>
      <ErrorLine code={error} />
      {props.trash && <p class="dim">{t("trash.note")}</p>}
      {projects === null ? (
        <p class="dim">{t("app.loading")}</p>
      ) : projects.length === 0 ? (
        <p class="dim">{t(props.trash ? "trash.empty" : "list.empty")}</p>
      ) : (
        <ul class={props.trash ? "projects" : "projects cards"}>
          {projects.map((p) => (
            <li key={p.id}>
              {!props.trash && <Thumb project={p} suffix={props.me.siteSuffix} />}
              {renaming === p.id ? (
                <NameForm
                  name={p.name}
                  suffix={props.me.siteSuffix}
                  onCancel={() => setRenaming(null)}
                  onSave={(name) => act(() => api("PATCH", `/api/projects/${p.id}`, { name }).then(() => setRenaming(null)))}
                />
              ) : props.trash ? (
                <>
                  <span class="project-name">{p.name}</span>
                  <span class="dim">{t("trash.deleted", { when: when(p.deleted_at ?? 0) })}</span>
                  <span class="grow" />
                  <button type="button" class="button" onClick={() => act(() => api("PATCH", `/api/projects/${p.id}`, { trashed: false }))}>
                    {t("trash.restore")}
                  </button>
                  <button
                    type="button"
                    class="button"
                    onClick={() => confirm(t("trash.foreverConfirm", { name: p.name })) && act(() => api("DELETE", `/api/projects/${p.id}`))}
                  >
                    {t("trash.forever")}
                  </button>
                </>
              ) : (
                <>
                  <A href={`/e/${p.name}`} class="project-name">
                    {p.name}
                  </A>
                  {p.shared && <span class="mark">{t("list.shared")}</span>}
                  <span class="dim">{t("list.edited", { when: when(p.updated_at) })}</span>
                  {p.blocked && <span class="blocked">{t("list.blocked", { reason: p.blocked })}</span>}
                  <span class="grow" />
                  <Menu
                    label="…"
                    title={t("list.rowMenu", { name: p.name })}
                    class="button quiet"
                    items={[
                      { label: t("list.rename"), run: () => setRenaming(p.id) },
                      { label: t("list.duplicate"), run: () => act(() => api("POST", `/api/projects/${p.id}/copy`)) },
                      {
                        label: t("list.delete"),
                        run: () => confirm(t("list.deleteConfirm", { name: p.name })) && act(() => api("DELETE", `/api/projects/${p.id}`)),
                      },
                    ]}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <p class="below">{props.trash ? <A href="/">{t("app.back")}</A> : <A href="/trash">{t("list.trash")}</A>}</p>
    </Shell>
  );
}

const THUMB_WIDTH = 1024;

/**
 * The project's own page from its private address, drawn small. The frame has an empty sandbox,
 * so the page runs no script: a page that hangs or plays sound cannot do so from the list.
 */
function Thumb(props: { project: ProjectInfo; suffix: string }) {
  const box = useRef<HTMLAnchorElement>(null);
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    const el = box.current!;
    const watch = new ResizeObserver(() => setScale(el.clientWidth / THUMB_WIDTH));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const { name, secret } = props.project;
  return (
    <a
      href={`/e/${name}`}
      class="thumb"
      ref={box}
      tabIndex={-1}
      aria-hidden="true"
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        go(`/e/${name}`);
      }}
    >
      {secret && scale > 0 && (
        <iframe src={`${location.protocol}//${name}--${secret}.${props.suffix}/`} sandbox="" loading="lazy" tabIndex={-1} scrolling="no" style={{ transform: `scale(${scale})` }} />
      )}
    </a>
  );
}

/** The rename field. It says that the name is the address and that old links stop working. */
export function NameForm(props: { name: string; suffix: string; onSave: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(props.name);
  return (
    <form
      class="name-form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave(value.trim().toLowerCase());
      }}
      onKeyDown={(e) => e.key === "Escape" && props.onCancel()}
    >
      <label>
        <span class="sr">{t("name.label")}</span>
        <input
          value={value}
          onInput={(e) => setValue(e.currentTarget.value)}
          ref={(el) => {
            if (!el || el.dataset.focused) return;
            el.dataset.focused = "1";
            el.select();
          }}
          spellcheck={false}
          autocapitalize="off"
          maxLength={40}
          aria-describedby="name-hint"
        />
      </label>
      <span class="dim">.{props.suffix}</span>
      <button type="submit" class="button">
        {t("name.save")}
      </button>
      <button type="button" class="button quiet" onClick={props.onCancel}>
        {t("name.cancel")}
      </button>
      <span class="dim hint-line" id="name-hint">
        {t("name.hint")}
      </span>
    </form>
  );
}

function Leave(props: { email: string }) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      class="panel"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api("DELETE", "/api/me", { confirm: typed });
          location.href = "/";
        } catch (err) {
          setError(codeOf(err));
        }
      }}
    >
      <h2>{t("account.deleteTitle")}</h2>
      <p>{t("account.deleteText")}</p>
      <ErrorLine code={error} />
      <label>
        <span class="sr">{props.email}</span>
        <input type="email" value={typed} placeholder={props.email} onInput={(e) => setTyped(e.currentTarget.value)} autocomplete="off" />
      </label>
      <button type="submit" class="button">
        {t("account.deleteButton")}
      </button>
    </form>
  );
}

/** maak.io/copy/name: a signed-in visitor gets a copy under a new name, opened in the editor. */
export function CopyPage(props: { name: string }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    api<{ project: ProjectInfo }>("POST", `/api/projects/${props.name}/copy`)
      .then(({ project }) => go(`/e/${project.name}`, true))
      .catch(() => setMissing(true));
  }, []);
  return <Shell>{missing ? <p class="error">{t("copy.missing")}</p> : <p class="dim">{t("copy.working")}</p>}</Shell>;
}

export function Report() {
  const [name, setName] = useState(new URLSearchParams(location.search).get("site") ?? "");
  const [reason, setReason] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Shell>
      <h1>{t("report.title")}</h1>
      {sent ? (
        <p role="status">{t("report.sent")}</p>
      ) : (
        <form
          class="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("POST", "/api/reports", { name, reason });
              setSent(true);
            } catch (err) {
              setError(codeOf(err));
            }
          }}
        >
          <p>{t("report.text")}</p>
          <ErrorLine code={error} />
          <label>
            {t("report.name")}
            <input value={name} onInput={(e) => setName(e.currentTarget.value)} required spellcheck={false} />
          </label>
          <label>
            {t("report.reason")}
            <textarea value={reason} onInput={(e) => setReason(e.currentTarget.value)} required rows={5} maxLength={2000} />
          </label>
          <button type="submit" class="button accent">
            {t("report.send")}
          </button>
        </form>
      )}
    </Shell>
  );
}

interface AdminState {
  signup: "open" | "closed";
  allowed: { pattern: string; note: string }[];
  invites: { code: string; uses_left: number; expires_at: number }[];
  reports: { id: number; project_name: string; reason: string; created_at: number; handled_at: number | null; shared: number | null }[];
  moderation: { at: number; admin: string; action: "block" | "unblock" | "suspend" | "restore" | "signup-open" | "signup-closed"; target: string; reason: string }[];
}

interface AdminProject {
  name: string;
  secret: string;
  shared: number;
  blocked_reason: string | null;
  deleted_at: number | null;
  updated_at: number;
  owner: string;
  suspended_at: number | null;
  files: number;
}

interface Person {
  id: string;
  email: string;
  seen_at: number;
  suspended_at: number | null;
  suspended_reason: string;
  projects: number;
}

export function Admin(props: { me: Me }) {
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pattern, setPattern] = useState("");
  const [note, setNote] = useState("");
  const [uses, setUses] = useState(30);
  const [days, setDays] = useState(14);
  const [lookup, setLookup] = useState("");
  const [project, setProject] = useState<AdminProject | null>(null);
  const [blockReason, setBlockReason] = useState("");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const projectBox = useRef<HTMLHeadingElement>(null);

  const load = () => api<AdminState>("GET", "/api/admin/state").then(setState).catch((e) => setError(codeOf(e)));
  const findProject = (name: string) =>
    api<{ project: AdminProject }>("GET", `/api/admin/projects/${encodeURIComponent(name.trim().toLowerCase())}`).then((r) =>
      setProject(r.project),
    );
  const findPeople = (q: string) =>
    api<{ people: Person[] }>("GET", `/api/admin/people?q=${encodeURIComponent(q)}`).then((r) => setPeople(r.people));
  useEffect(() => {
    void load();
    void findPeople("").catch((e) => setError(codeOf(e)));
  }, []);
  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      await load();
    } catch (e) {
      setError(codeOf(e));
    }
  };
  const look = (name: string) => {
    setLookup(name);
    void act(() => findProject(name)).then(() => projectBox.current?.scrollIntoView({ block: "start" }));
  };
  const suspend = (person: Person) => {
    const reason = prompt(t("admin.suspendReason", { email: person.email }));
    if (reason?.trim()) void act(() => api("POST", `/api/admin/people/${person.id}`, { suspend: true, reason }).then(() => findPeople(query)));
  };

  if (!state) return <Shell>{error ? <ErrorLine code={error} /> : <p class="dim">{t("app.loading")}</p>}</Shell>;
  const preview = project && `${location.protocol}//${project.name}--${project.secret}.${props.me.siteSuffix}/`;
  return (
    <Shell>
      <h1>{t("admin.title")}</h1>
      <ErrorLine code={error} />

      <h2>{t("admin.reports")}</h2>
      {state.reports.length === 0 && <p class="dim">{t("admin.noReports")}</p>}
      <ul class="projects">
        {state.reports.map((r) => (
          <li key={r.id} class={r.handled_at ? "dim" : ""}>
            <span class="project-name">{r.project_name}</span>
            {r.shared === 1 && <span class="mark">{t("admin.isShared")}</span>}
            <span class="reason">{r.reason}</span>
            <span class="dim">{when(r.created_at)}</span>
            <span class="grow" />
            <button type="button" class="button" onClick={() => look(r.project_name)}>
              {t("admin.look")}
            </button>
            {r.handled_at ? (
              <span>{t("admin.handled")}</span>
            ) : (
              <button type="button" class="button quiet" onClick={() => act(() => api("POST", `/api/admin/reports/${r.id}`, {}))}>
                {t("admin.done")}
              </button>
            )}
          </li>
        ))}
      </ul>

      <h2 ref={projectBox}>{t("admin.project")}</h2>
      <p class="dim">{t("admin.projectHint")}</p>
      <form
        class="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => findProject(lookup));
        }}
      >
        <label>
          {t("admin.project")}
          <input value={lookup} onInput={(e) => setLookup(e.currentTarget.value)} required spellcheck={false} />
        </label>
        <button type="submit" class="button">
          {t("admin.find")}
        </button>
      </form>
      {project && (
        <div class="admin-project">
          <p>
            <span class="project-name">{project.name}</span>{" "}
            {project.shared === 1 && <span class="mark">{t("admin.isShared")}</span>}{" "}
            {project.deleted_at !== null && <span class="mark">{t("admin.inTrash")}</span>}
          </p>
          <p>{t("admin.owner", { email: project.owner })}</p>
          <p class="dim">{t("admin.files", { count: project.files, when: when(project.updated_at) })}</p>
          <p>
            <a href={preview!} target="_blank" rel="noopener noreferrer">
              {t("admin.openPreview")}
            </a>
          </p>
          {project.blocked_reason !== null ? (
            <>
              <p class="blocked">{t("admin.blockedBecause", { reason: project.blocked_reason })}</p>
              <button
                type="button"
                class="button"
                onClick={() => act(() => api("POST", `/api/admin/projects/${project.name}`, { block: false }).then(() => findProject(project.name)))}
              >
                {t("admin.unblock")}
              </button>
            </>
          ) : (
            <form
              class="row-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act(() =>
                  api("POST", `/api/admin/projects/${project.name}`, { block: true, reason: blockReason }).then(() => {
                    setBlockReason("");
                    return findProject(project.name);
                  }),
                );
              }}
            >
              <label class="wide">
                {t("admin.reason")}
                <input value={blockReason} onInput={(e) => setBlockReason(e.currentTarget.value)} required maxLength={1000} />
              </label>
              <button type="submit" class="button">
                {t("admin.block")}
              </button>
            </form>
          )}
        </div>
      )}

      <h2>{t("admin.people")}</h2>
      <form
        class="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => findPeople(query));
        }}
      >
        <label>
          {t("admin.search")}
          <input type="search" value={query} onInput={(e) => setQuery(e.currentTarget.value)} spellcheck={false} />
        </label>
        <button type="submit" class="button">
          {t("admin.find")}
        </button>
      </form>
      <ul class="projects">
        {people.map((p) => (
          <li key={p.id} class={p.suspended_at ? "dim" : ""}>
            <span class="project-name">{p.email}</span>
            <span class="dim">{t("admin.personLine", { count: p.projects, when: when(p.seen_at) })}</span>
            {p.suspended_at && <span class="reason blocked">{t("admin.suspended", { reason: p.suspended_reason })}</span>}
            <span class="grow" />
            {p.suspended_at ? (
              <button
                type="button"
                class="button"
                onClick={() => act(() => api("POST", `/api/admin/people/${p.id}`, { suspend: false }).then(() => findPeople(query)))}
              >
                {t("admin.restore")}
              </button>
            ) : (
              <button type="button" class="button quiet" onClick={() => suspend(p)}>
                {t("admin.suspend")}
              </button>
            )}
          </li>
        ))}
      </ul>

      <h2>{t("admin.log")}</h2>
      {state.moderation.length === 0 && <p class="dim">{t("admin.logEmpty")}</p>}
      <ul class="projects">
        {state.moderation.map((m) => (
          <li key={`${m.at}-${m.target}`}>
            <span class="dim">{when(m.at)}</span>
            <span>
              {m.admin} {t(`admin.action.${m.action}`)} <strong>{m.target}</strong>
            </span>
            {m.reason && <span class="reason">{m.reason}</span>}
          </li>
        ))}
      </ul>

      <h2>{t("admin.signup")}</h2>
      <p class="row-form">
        <span>{t(state.signup === "open" ? "admin.signup.open" : "admin.signup.closed")}</span>
        <button
          type="button"
          class="button"
          onClick={() => act(() => api("POST", "/api/admin/signup", { signup: state.signup === "open" ? "closed" : "open" }))}
        >
          {t(state.signup === "open" ? "admin.signup.close" : "admin.signup.reopen")}
        </button>
      </p>

      <h2>{t("admin.allowed")}</h2>
      <p class="dim">{t("admin.allowedHint")}</p>
      <form
        class="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => api("POST", "/api/admin/allowed", { pattern, note }).then(() => (setPattern(""), setNote(""))));
        }}
      >
        <label>
          {t("admin.pattern")}
          <input value={pattern} onInput={(e) => setPattern(e.currentTarget.value)} required spellcheck={false} />
        </label>
        <label>
          {t("admin.note")}
          <input value={note} onInput={(e) => setNote(e.currentTarget.value)} />
        </label>
        <button type="submit" class="button">
          {t("admin.add")}
        </button>
      </form>
      <ul class="projects">
        {state.allowed.map((a) => (
          <li key={a.pattern}>
            <span class="project-name">{a.pattern}</span>
            <span class="dim">{a.note}</span>
            <span class="grow" />
            <button type="button" class="button quiet" onClick={() => act(() => api("DELETE", "/api/admin/allowed", { pattern: a.pattern }))}>
              {t("admin.remove")}
            </button>
          </li>
        ))}
      </ul>

      <h2>{t("admin.invites")}</h2>
      <form
        class="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => api("POST", "/api/admin/invites", { uses, days }));
        }}
      >
        <label>
          {t("admin.uses")}
          <input type="number" min={1} max={500} value={uses} onInput={(e) => setUses(Number(e.currentTarget.value))} />
        </label>
        <label>
          {t("admin.days")}
          <input type="number" min={1} max={90} value={days} onInput={(e) => setDays(Number(e.currentTarget.value))} />
        </label>
        <button type="submit" class="button">
          {t("admin.create")}
        </button>
      </form>
      <ul class="projects">
        {state.invites.map((i) => (
          <li key={i.code}>
            <code>{`${location.origin}/?invite=${i.code}`}</code>
            <span class="dim">{t("admin.usesLeft", { count: i.uses_left, when: when(i.expires_at) })}</span>
            <span class="grow" />
            <CopyButton text={`${location.origin}/?invite=${i.code}`} label={t("share.copy")} done={t("share.copied")} />
          </li>
        ))}
      </ul>
    </Shell>
  );
}

// The terms and privacy texts are drafts. They state what the software does; the legal questions
// in the spec (controller, retention, minors) are not settled here.
const TEXTS: Record<"about" | "terms" | "privacy", Record<Lang, { title: string; draft: boolean; body: string[] }>> = {
  about: {
    nl: {
      title: "Wat is maak?",
      draft: false,
      body: [
        "maak is een editor in je browser waarin je een echte website schrijft: HTML, CSS en later JavaScript. Je ziet het resultaat meteen naast je code.",
        "Een project is een map met echte bestanden. Elk project heeft één adres, naam.{suffix}. Zolang je niet deelt, zie alleen jij het.",
        "Er is geen knop om op te slaan. Wat je typt wordt bewaard, en Geschiedenis brengt een eerdere versie terug.",
        "De bestanden zijn van jou. Met ZIP downloaden krijg je de map zoals ze is, en ze werkt ook zonder maak.",
        "Vragen: {contact}.",
      ],
    },
    en: {
      title: "What is maak?",
      draft: false,
      body: [
        "maak is an editor in your browser where you write a real website: HTML, CSS and later JavaScript. You see the result next to your code as you type.",
        "A project is a folder of real files. Every project has one address, name.{suffix}. Until you share it, only you can see it.",
        "There is no save button. What you type is kept, and History brings back an earlier version.",
        "The files are yours. Download ZIP gives you the folder as it is, and it works without maak.",
        "Questions: {contact}.",
      ],
    },
  },
  terms: {
    nl: {
      title: "Voorwaarden",
      draft: true,
      body: [
        "Wat je op maak maakt, blijft van jou. maak.io vraagt geen rechten op je werk.",
        "Een gedeelde site is zichtbaar voor iedereen met het adres, en iedereen kan er een eigen kopie van maken. De broncode van een openbare webpagina is altijd openbaar.",
        "Zet geen sites online die misleiden, schade doen of het werk of de gegevens van anderen zonder toestemming gebruiken. Een beheerder kan het delen van zo'n site uitzetten.",
        "Je kunt je werk altijd downloaden en je account verwijderen.",
      ],
    },
    en: {
      title: "Terms",
      draft: true,
      body: [
        "What you make on maak stays yours. maak.io claims no rights to your work.",
        "A shared site is visible to anyone with the address, and anyone can make their own copy of it. The source of a public web page is always public.",
        "Do not publish sites that mislead, do harm, or use the work or data of others without permission. An administrator can switch off sharing for such a site.",
        "You can download your work and delete your account at any time.",
      ],
    },
  },
  privacy: {
    nl: {
      title: "Privacy",
      draft: true,
      body: [
        "maak.io bewaart over jou: het kenmerk van je account bij de aanmeldaanbieder, je e-mailadres, je naam, je taal, en wanneer je account is gemaakt en laatst gebruikt. Geen wachtwoord, geen foto, geen profiel.",
        "Daarnaast bewaart maak.io de bestanden van je projecten en hun geschiedenis van 30 dagen.",
        "Een project is privé tot je het deelt. Gedeelde sites vragen zoekmachines om ze niet op te nemen.",
        "De editor laadt geen scripts, lettertypes of statistieken van andere partijen. maak.io gebruikt één cookie, om je aangemeld te houden.",
        "Met 'Al mijn projecten downloaden' krijg je al je werk. Met 'Account verwijderen' gaan je sites meteen offline en worden je gegevens binnen 30 dagen gewist.",
        "Vragen of een verzoek over je gegevens: {contact}.",
      ],
    },
    en: {
      title: "Privacy",
      draft: true,
      body: [
        "maak.io stores about you: the identifier of your account at the sign-in provider, your email address, your name, your language, and when your account was created and last used. No password, no photo, no profile.",
        "maak.io also stores the files of your projects and their history of 30 days.",
        "A project is private until you share it. Shared sites ask search engines not to index them.",
        "The editor loads no scripts, fonts or analytics from other parties. maak.io uses one cookie, to keep you signed in.",
        "'Download all my projects' gives you all your work. 'Delete account' takes your sites offline at once and erases your data within 30 days.",
        "Questions or a request about your data: {contact}.",
      ],
    },
  },
};

export function TextPage(props: { which: "about" | "terms" | "privacy"; me: Me }) {
  const text = TEXTS[props.which][getLang()];
  const fill = (line: string) => line.replace("{suffix}", props.me.siteSuffix).replace("{contact}", props.me.contact);
  return (
    <Shell>
      <article class="text">
        <h1>{text.title}</h1>
        {text.draft && <p class="error">{getLang() === "nl" ? "Ontwerp, nog niet nagelezen." : "Draft, not yet reviewed."}</p>}
        {text.body.map((line) => (
          <p>{fill(line)}</p>
        ))}
      </article>
    </Shell>
  );
}
