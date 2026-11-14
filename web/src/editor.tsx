// The editor screen: files on the left, three boxes in the middle, the live site on the right.
// The same screen shows another person's shared project read-only (the code view at /p/name).

import {
  ChevronDown,
  ClipboardCopy,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  FilePlus,
  Folder,
  FolderPlus,
  Globe,
  History as HistoryIcon,
  Link2,
  Pencil,
  RotateCw,
  Trash2,
  Upload,
} from "lucide-preact";
import { Fragment } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { LIMITS, boxOf, isImage, pathHint } from "../../src/shared/rules";
import { type FileRow, type Me, type ProjectInfo, api } from "./api";
import { DRAG, type Drops, EditorView, emptyState, makeState, type EditorState } from "./cm";
import { type Key, errorText, size, t, when } from "./i18n";
import { PRESETS } from "./resize";
import { ThemeToggle } from "./look";
import { NameForm } from "./pages";
import { EditorStore, baseOf, parentOf } from "./store";
import { A, CopyButton, Menu, Popover, go, useStore } from "./ui";
import { downloadProject } from "./zip";

export function EditorPage(props: { me: Me; name: string; readOnly: boolean }) {
  const [store, setStore] = useState<EditorStore | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    // A rename changes the address of this page. The project is already open, so keep it.
    if (store && store.project.name === props.name) return;
    let live = true;
    setStore(null);
    setMissing(false);
    (async () => {
      const { project } = await api<{ project: ProjectInfo }>(
        "GET",
        `/api/projects/${props.name}`,
      );
      if (!props.readOnly && !project.owner)
        return go(`/p/${project.name}`, true);
      const next = new EditorStore(
        props.readOnly
          ? { ...project, owner: false, secret: undefined }
          : project,
        props.me.siteSuffix,
      );
      await next.load();
      if (live) setStore(next);
    })().catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [props.name, props.readOnly]);

  if (missing) {
    return (
      <main class="page">
        <p>{t("copy.missing")}</p>
        <A href="/">{t("app.back")}</A>
      </main>
    );
  }
  if (!store) return <p class="center">{t("app.loading")}</p>;
  return <Editor store={store} me={props.me} />;
}

type Tab = "files" | "code" | "preview";

/** Every icon is decoration next to a text or a labelled button, so screen readers skip it. */
const ICON = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;

const KINDS = ["html", "css", "js"];

/** A small mark in the colour of the file's kind: HTML, CSS, JS, or anything else. */
function Kind({ path, box }: { path?: string; box?: number }) {
  const kind = box ?? (path ? boxOf(path) : null);
  return (
    <i
      class={`kind kind-${kind === null || kind === undefined ? "other" : KINDS[kind]}`}
      aria-hidden="true"
    />
  );
}

function Editor({ store, me }: { store: EditorStore; me: Me }) {
  useStore(store);
  const [treeWidth, setTreeWidth] = useState(280);
  const [boxWidth, setBoxWidth] = useState(() =>
    Math.max(320, Math.round(innerWidth * 0.36)),
  );
  const [tab, setTab] = useState<Tab>("code");
  const [history, setHistory] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    document.title = `${store.project.name} · maak`;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        store.flashStatus();
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => {
      if (store.unsaved) e.preventDefault();
    };
    const onOnline = () => store.flushAll();
    addEventListener("keydown", onKey);
    addEventListener("beforeunload", onLeave);
    addEventListener("online", onOnline);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("beforeunload", onLeave);
      removeEventListener("online", onOnline);
      document.title = "maak";
    };
  }, [store]);

  const tabs: [Tab, string][] = [
    ["files", t("files.tab")],
    ["code", t("box.tab")],
    ["preview", t("preview.tab")],
  ];

  return (
    <div
      class={`editor${dragging ? " dragging" : ""}`}
      data-tab={tab}
      style={{ "--tree": `${treeWidth}px`, "--boxes": `${boxWidth}px` }}
    >
      <TopBar store={store} me={me} onHistory={() => setHistory(true)} />
      {store.signedOut && (
        <div class="strip warn" role="alert">
          {t("status.signedOut")}{" "}
          <a href="/auth/login?next=/about" target="_blank" rel="noopener">
            {t("status.signIn")}
          </a>
        </div>
      )}
      <div class="tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div class="panes">
        <section class="pane pane-files" aria-label={t("files.title")}>
          {history ? (
            <History
              store={store}
              onClose={() => {
                store.view(null);
                setHistory(false);
              }}
            />
          ) : (
            <Tree store={store} onOpen={() => setTab("code")} />
          )}
        </section>
        <Divider
          onDrag={setDragging}
          onMove={(dx) =>
            setTreeWidth((w) => Math.min(Math.max(w + dx, 140), 480))
          }
        />
        <section class="pane pane-code" aria-label={t("box.tab")}>
          {[0, 1, 2].map((box) => (
            <Box key={box} store={store} box={box} />
          ))}
        </section>
        <Divider
          onDrag={setDragging}
          onMove={(dx) =>
            setBoxWidth((w) =>
              Math.min(Math.max(w + dx, 240), innerWidth - 300),
            )
          }
        />
        <section class="pane pane-preview" aria-label={t("preview.tab")}>
          <Preview store={store} />
        </section>
      </div>
      {store.ask && <ResizeDialog store={store} />}
      {store.notice && (
        <div class="notice" role="alert">
          <strong>{t("err.title")}</strong>
          <span>{errorText(store.notice)}</span>
          <button
            type="button"
            class="button quiet"
            onClick={() => {
              store.notice = null;
              store.emit();
            }}
          >
            {t("err.close")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Asks what size the images of an upload should get. One choice goes for the whole batch.
 * Each choice says what it is for and how many pixels it is.
 */
function ResizeDialog({ store }: { store: EditorStore }) {
  const { big } = store.ask!;
  const [choice, setChoice] = useState<number | null>(1280);
  const largest = big.reduce((a, b) =>
    b.width * b.height > a.width * a.height ? b : a,
  );
  const facts = {
    count: big.length,
    name: largest.file.name,
    width: largest.width,
    height: largest.height,
    size: size(largest.file.size),
  };
  const options: { pixels: number | null; label: string; hint: string }[] = [
    ...PRESETS.map((p) => ({
      pixels: p.pixels as number | null,
      label: t(`resize.${p.id}` as Key),
      hint: t(`resize.${p.id}Hint` as Key),
    })),
    { pixels: null, label: t("resize.keep"), hint: t("resize.keepHint") },
  ];
  return (
    <div
      class="overlay"
      onKeyDown={(e) => e.key === "Escape" && void store.answer("cancel")}
    >
      <form
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="resize-title"
        onSubmit={(e) => {
          e.preventDefault();
          void store.answer(choice);
        }}
      >
        <h2 id="resize-title">{t("resize.title")}</h2>
        <p>{t(big.length === 1 ? "resize.one" : "resize.many", facts)}</p>
        <p class="dim">{t("resize.how")}</p>
        <div class="choices" role="radiogroup" aria-labelledby="resize-title">
          {options.map((option) => (
            <label class={choice === option.pixels ? "chosen" : ""}>
              <input
                type="radio"
                name="size"
                checked={choice === option.pixels}
                onChange={() => setChoice(option.pixels)}
                ref={(el) => {
                  if (el && option.pixels === 1280 && !el.dataset.focused) {
                    el.dataset.focused = "1";
                    el.focus();
                  }
                }}
              />
              <span class="choice-name">{option.label}</span>
              <span class="choice-pixels">
                {option.pixels
                  ? `${option.pixels} px`
                  : `${largest.width} × ${largest.height} px`}
              </span>
              <span class="choice-hint dim">{option.hint}</span>
            </label>
          ))}
        </div>
        <div class="dialog-actions">
          <button
            type="button"
            class="button quiet"
            onClick={() => void store.answer("cancel")}
          >
            {t("resize.cancel")}
          </button>
          <button type="submit" class="button accent">
            <Upload {...ICON} />
            {t("resize.go")}
          </button>
        </div>
      </form>
    </div>
  );
}

/** A divider that drags with the pointer and moves with the arrow keys. */
function Divider(props: {
  onMove: (dx: number) => void;
  onDrag: (active: boolean) => void;
}) {
  const last = useRef(0);
  return (
    <div
      class="divider"
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={(e) => {
        last.current = e.clientX;
        e.currentTarget.setPointerCapture(e.pointerId);
        props.onDrag(true);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        props.onMove(e.clientX - last.current);
        last.current = e.clientX;
      }}
      onPointerUp={() => props.onDrag(false)}
      onPointerCancel={() => props.onDrag(false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") props.onMove(-24);
        if (e.key === "ArrowRight") props.onMove(24);
      }}
    />
  );
}

function TopBar({
  store,
  me,
  onHistory,
}: {
  store: EditorStore;
  me: Me;
  onHistory: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const { project } = store;
  const status = store.status;
  const copy = async () => {
    if (!me.user) return go(`/copy/${project.name}`);
    try {
      const made = await api<{ project: ProjectInfo }>(
        "POST",
        `/api/projects/${project.id}/copy`,
      );
      go(`/e/${made.project.name}`);
    } catch (error) {
      store.fail(error);
    }
  };

  return (
    <header class="bar">
      <A href="/" class="home" aria-label={t("bar.home")}>
        maak
      </A>
      {renaming ? (
        <NameForm
          name={project.name}
          suffix={store.siteSuffix}
          onCancel={() => setRenaming(false)}
          onSave={async (name) => {
            if (name === project.name || (await store.patch({ name }))) {
              setRenaming(false);
              go(`/e/${store.project.name}`, true);
            }
          }}
        />
      ) : store.readOnly ? (
        <span class="address">
          {project.name}
          <span class="dim">.{store.siteSuffix}</span>
        </span>
      ) : (
        <button
          type="button"
          class="address"
          onClick={() => setRenaming(true)}
          aria-label={t("bar.rename", { name: project.name })}
        >
          {project.name}
          <span class="dim">.{store.siteSuffix}</span>
        </button>
      )}
      {store.readOnly ? (
        <span class="status">{t("bar.readOnly")}</span>
      ) : (
        <span class="status" role="status" data-status={status}>
          {/* The key restarts the flash that answers Cmd/Ctrl+S. */}
          <span key={store.flash} class={store.flash ? "flash" : ""}>
            {t(`status.${status}`)}
          </span>
        </span>
      )}
      <span class="grow" />
      <ThemeToggle />
      {store.readOnly ? (
        <button type="button" class="button accent" onClick={copy}>
          {t("bar.copy")}
        </button>
      ) : (
        <>
          <Popover
            label={
              <>
                <Globe {...ICON} />
                {t("bar.share")}
              </>
            }
            class="button accent"
          >
            <Share store={store} />
          </Popover>
          <button
            type="button"
            class="button"
            aria-label={t("bar.zip")}
            title={t("bar.zip")}
            onClick={() =>
              void downloadProject(store).catch((e) => store.fail(e))
            }
          >
            <Download {...ICON} />
            <span class="label">{t("bar.zip")}</span>
          </button>
          <Menu
            label={<Ellipsis {...ICON} />}
            title={t("bar.more")}
            items={[
              {
                label: t("bar.history"),
                icon: <HistoryIcon {...ICON} />,
                run: onHistory,
              },
              { label: t("bar.copy"), icon: <Copy {...ICON} />, run: copy },
              {
                label: t("bar.resetLink"),
                icon: <Link2 {...ICON} />,
                run: () => void store.patch({ resetSecret: true }),
              },
              {
                label: t("bar.delete"),
                icon: <Trash2 {...ICON} />,
                run: async () => {
                  if (!confirm(t("list.deleteConfirm", { name: project.name })))
                    return;
                  await api("DELETE", `/api/projects/${project.id}`).catch(
                    (e) => store.fail(e),
                  );
                  go("/");
                },
              },
            ]}
          />
        </>
      )}
    </header>
  );
}

/** One switch. When it is on, the address and the copy link appear. */
function Share({ store }: { store: EditorStore }) {
  const { project } = store;
  const copyLink = `${location.origin}/copy/${project.name}`;
  return (
    <div class="share">
      <label class="switch">
        <input
          type="checkbox"
          role="switch"
          checked={project.shared}
          onChange={(e) =>
            void store.patch({ shared: e.currentTarget.checked })
          }
        />
        {t("share.switch")}
      </label>
      {project.shared ? (
        <>
          <div class="copy-row">
            <input
              readOnly
              value={store.siteUrl}
              aria-label={t("preview.address")}
              onFocus={(e) => e.currentTarget.select()}
            />
            <CopyButton
              text={store.siteUrl}
              label={t("share.copy")}
              done={t("share.copied")}
            />
          </div>
          <div class="copy-row small">
            <span class="dim">{t("share.copyLink")}</span>
            <CopyButton
              text={copyLink}
              label={t("share.copy")}
              done={t("share.copied")}
            />
          </div>
        </>
      ) : (
        <p class="dim">{t("share.private")}</p>
      )}
    </div>
  );
}

interface TreeRow {
  file: FileRow;
  depth: number;
}

/** Folders first, then files, each in alphabetical order, as a flat list with a depth. */
function treeRows(files: FileRow[]): TreeRow[] {
  const children = new Map<string, FileRow[]>();
  for (const file of files) {
    const parent = parentOf(file.path);
    children.set(parent, [...(children.get(parent) ?? []), file]);
  }
  const out: TreeRow[] = [];
  const walk = (parent: string, depth: number) => {
    const list = (children.get(parent) ?? []).sort(
      (a, b) =>
        Number(b.kind === "folder") - Number(a.kind === "folder") ||
        baseOf(a.path).localeCompare(baseOf(b.path)),
    );
    for (const file of list) {
      out.push({ file, depth });
      if (file.kind === "folder") walk(file.path, depth + 1);
    }
  };
  walk("", 0);
  return out;
}


function Tree({ store, onOpen }: { store: EditorStore; onOpen: () => void }) {
  const [naming, setNaming] = useState<{
    kind: "file" | "folder" | "rename" | "duplicate";
    path: string;
  } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => treeRows(store.files), [store.files]);
  const ro = store.readOnly;

  const commit = async (value: string) => {
    const name = value.trim().replace(/^\/+|\/+$/g, "");
    if (!naming || !name) return setNaming(null);
    const done =
      naming.kind === "file"
        ? await store.createFile(name)
        : naming.kind === "folder"
          ? await store.createFolder(name)
          : naming.kind === "duplicate"
            ? await store.duplicate(naming.path, name)
            : await store.move(naming.path, name);
    if (done && naming.kind === "duplicate") onOpen();
    if (done) setNaming(null);
  };

  const nameInput = (initial: string, placeholder: string) => (
    <input
      class="name-input"
      aria-label={t("files.nameLabel")}
      placeholder={placeholder}
      defaultValue={initial}
      spellcheck={false}
      autocapitalize="off"
      ref={(el) => {
        if (!el || el.dataset.focused) return;
        el.dataset.focused = "1";
        el.focus();
        // Select the name without its folder and extension, which is the part people change.
        const start = initial.lastIndexOf("/") + 1;
        const dot = initial.lastIndexOf(".");
        el.setSelectionRange(start, dot > start ? dot : initial.length);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") void commit(e.currentTarget.value);
        if (e.key === "Escape") setNaming(null);
      }}
      onBlur={(e) => {
        // Closing an error message must not throw away the name that was being typed.
        if ((e.relatedTarget as HTMLElement | null)?.closest(".notice")) return;
        setNaming(null);
      }}
    />
  );

  // The path being dragged inside the tree, or null for files that come from the computer.
  const dragged = useRef<string | null>(null);

  // Dropping on a folder puts things in it. Dropping on a file or on the empty space uses that level.
  // The highlight changes only when the target changes, and there is none where a drop would
  // move nothing: the folder the file is already in, the folder itself, or a folder inside it.
  const dropProps = (folder: string) =>
    ro
      ? {}
      : {
          onDragOver: (e: DragEvent) => {
            const types = e.dataTransfer?.types ?? [];
            if (!types.includes(DRAG) && !types.includes("Files")) return;
            e.stopPropagation();
            const from = dragged.current;
            const pointless = from !== null && (parentOf(from) === folder || folder === from || folder.startsWith(`${from}/`));
            if (!pointless) e.preventDefault();
            const next = pointless ? null : folder;
            setOver((old) => (old === next ? old : next));
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(null);
            const from = e.dataTransfer?.getData(DRAG);
            dragged.current = null;
            if (from) {
              const to = folder ? `${folder}/${baseOf(from)}` : baseOf(from);
              if (parentOf(from) !== folder) void store.move(from, to);
            } else if (e.dataTransfer?.files.length) {
              void store.offer([...e.dataTransfer.files], folder);
            }
          },
        };

  // dragleave also fires when the pointer moves from one row to the next. Only leaving the
  // tree as a whole clears the highlight.
  const leaveTree = (e: DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setOver(null);
  };

  const remove = (file: FileRow) => {
    if (file.kind === "folder") {
      const count = store.files.filter(
        (f) => f.kind === "file" && f.path.startsWith(`${file.path}/`),
      ).length;
      if (!confirm(t("files.deleteFolder", { name: file.path, count }))) return;
    }
    void store.remove(file.path);
  };

  return (
    <div class={`tree${over === "" ? " over" : ""}`} {...dropProps("")} onDragLeave={ro ? undefined : leaveTree}>
      <div class="tree-head">
        <h2>{t("files.title")}</h2>
        <span class="grow" />
        {!ro && (
          <>
            <button
              type="button"
              class="button small"
              aria-label={t("files.upload")}
              title={t("files.upload")}
              onClick={() => picker.current?.click()}
            >
              <Upload {...ICON} />
              <span class="label">{t("files.upload")}</span>
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label={t("files.newFile")}
              title={t("files.newFile")}
              onClick={() => setNaming({ kind: "file", path: "" })}
            >
              <FilePlus {...ICON} size={18} />
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label={t("files.newFolder")}
              title={t("files.newFolder")}
              onClick={() => setNaming({ kind: "folder", path: "" })}
            >
              <FolderPlus {...ICON} size={18} />
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void store.offer([...(e.currentTarget.files ?? [])], "");
                e.currentTarget.value = "";
              }}
            />
          </>
        )}
      </div>
      <ul class="rows">
        {naming && (naming.kind === "file" || naming.kind === "folder") && (
          <li class="row">
            {nameInput(
              "",
              t(
                naming.kind === "file"
                  ? "files.namePlaceholder"
                  : "files.folderPlaceholder",
              ),
            )}
          </li>
        )}
        {rows.map(({ file, depth }) => {
          const folder = file.kind === "folder";
          const target = folder ? file.path : parentOf(file.path);
          const name = baseOf(file.path);
          const progress = store.uploads.get(file.path);
          if (naming?.kind === "rename" && naming.path === file.path) {
            return (
              <li class="row" key={file.path}>
                {nameInput(file.path, "")}
              </li>
            );
          }
          // index.html becomes index-kopie.html: same folder, same extension, a free name.
          const copyName = () => {
            const dot = file.path.lastIndexOf(".");
            const stem =
              dot > file.path.lastIndexOf("/")
                ? file.path.slice(0, dot)
                : file.path;
            const tail = file.path.slice(stem.length);
            let candidate = `${stem}-${t("files.copySuffix")}${tail}`;
            for (let n = 2; store.files.some((f) => f.path === candidate); n++)
              candidate = `${stem}-${t("files.copySuffix")}-${n}${tail}`;
            return candidate;
          };
          return (
            <Fragment key={file.path}>
              <li
                class={`row${store.selected === file.path ? " selected" : ""}${folder && over === file.path ? " over" : ""}`}
                style={{ paddingLeft: `${8 + depth * 16}px` }}
                draggable={!ro}
                onDragStart={(e) => {
                  dragged.current = file.path;
                  e.dataTransfer?.setData(DRAG, file.path);
                  // Move within the tree, copy onto the code (an image becomes an <img> tag).
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
                }}
                onDragEnd={() => {
                  dragged.current = null;
                  setOver(null);
                }}
                // A right-click opens the same menu as the three dots, in place of the browser's own.
                onContextMenu={(e) => {
                  const menu = e.currentTarget.querySelector<HTMLButtonElement>(".row-menu");
                  if (!menu) return;
                  e.preventDefault();
                  if (menu.getAttribute("aria-expanded") !== "true") menu.click();
                }}
                {...dropProps(target)}
              >
                {folder ? (
                  <span class="row-name folder">
                    <Folder {...ICON} size={14} />
                    {name}/
                  </span>
                ) : (
                  <button
                    type="button"
                    class="row-name"
                    aria-current={
                      store.selected === file.path ? "true" : undefined
                    }
                    onClick={() => {
                      void store.open(file.path);
                      if (!isImage(file.path)) onOpen();
                    }}
                  >
                    <Kind path={file.path} />
                    {name}
                  </button>
                )}
                {pathHint(name) && (
                  <span
                    class="hint"
                    title={t("files.hint")}
                    aria-label={t("files.hint")}
                    role="img"
                  >
                    Aa
                  </span>
                )}
                {progress !== undefined ? (
                  <span class="size">{Math.round(progress * 100)}%</span>
                ) : (
                  file.size > LIMITS.sizeHint && (
                    <span class="size">{size(file.size)}</span>
                  )
                )}
                {!ro && (
                  <Menu
                    label={<Ellipsis {...ICON} />}
                    title={t("files.rowMenu", { name })}
                    class="row-menu"
                    items={[
                      {
                        label: t("files.rename"),
                        icon: <Pencil {...ICON} />,
                        run: () =>
                          setNaming({ kind: "rename", path: file.path }),
                      },
                      ...(folder
                        ? []
                        : [
                            {
                              label: t("files.duplicate"),
                              icon: <Copy {...ICON} />,
                              run: () =>
                                setNaming({
                                  kind: "duplicate",
                                  path: file.path,
                                }),
                            },
                          ]),
                      {
                        label: t("files.copyPath"),
                        icon: <ClipboardCopy {...ICON} />,
                        run: () =>
                          void navigator.clipboard
                            .writeText(file.path)
                            .catch(() => null),
                      },
                      {
                        label: t("files.delete"),
                        icon: <Trash2 {...ICON} />,
                        run: () => remove(file),
                      },
                    ]}
                  />
                )}
              </li>
              {naming?.kind === "duplicate" && naming.path === file.path && (
                <li class="row" style={{ paddingLeft: `${8 + depth * 16}px` }}>
                  {nameInput(copyName(), "")}
                </li>
              )}
            </Fragment>
          );
        })}
        {[...store.uploads]
          .filter(([path]) => !store.files.some((f) => f.path === path))
          .map(([path, done]) => (
            <li class="row dim" key={`up:${path}`}>
              <span class="row-name">{path}</span>
              <span class="size">{Math.round(done * 100)}%</span>
            </li>
          ))}
      </ul>
      {!ro && <p class="drop-hint">{t("files.drop")}</p>}
    </div>
  );
}

/** The path to write in an HTML file to reach another file: relative, with spaces and the like encoded. */
function relativePath(html: string, to: string): string {
  const here = parentOf(html).split("/").filter(Boolean);
  const there = to.split("/");
  let shared = 0;
  while (shared < here.length && shared < there.length - 1 && here[shared] === there[shared]) shared++;
  return [...here.slice(shared).map(() => ".."), ...there.slice(shared).map(encodeURIComponent)].join("/");
}

/**
 * An image dropped on HTML code becomes an <img> tag at that spot. The alt text is left empty
 * with the cursor in it. An image from the computer is uploaded next to the HTML file first.
 */
function imageDrops(store: EditorStore, html: string): Drops {
  const tag = (path: string) => `<img src="${relativePath(html, path)}" alt="">`;
  return {
    path: (from) => (isImage(from) ? tag(from) : null),
    files: async (files) => {
      const paths = await store.offer(files, parentOf(html));
      return paths.length ? paths.map(tag).join("\n") : null;
    },
  };
}

function Box({ store, box }: { store: EditorStore; box: number }) {
  const path = store.boxes[box];
  const doc = path ? store.docs.get(path) : undefined;
  const folded = store.folded[box];
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Each file keeps its own editor state, so undo is per file.
  const states = useRef(new Map<string, EditorState>());
  const shown = useRef("");
  const key = path && doc ? `${path}#${doc.external}` : "";
  const candidates = store.filesOfBox(box);
  const name = path ? baseOf(path) : ["HTML", "CSS", "JS"][box];

  useEffect(() => {
    view.current = new EditorView({
      parent: host.current!,
      state: emptyState(),
    });
    return () => view.current?.destroy();
  }, []);

  useEffect(() => {
    const v = view.current!;
    if (shown.current) states.current.set(shown.current, v.state);
    shown.current = key;
    if (!key || !path || !doc) return v.setState(emptyState());
    const opened = path;
    v.setState(
      states.current.get(key) ??
        makeState(
          opened,
          doc.text,
          store.readOnly,
          t("box.editor", { name: opened }),
          (text) => store.edit(opened, text),
          /\.html?$/i.test(opened) ? imageDrops(store, opened) : undefined,
        ),
    );
  }, [key]);

  useEffect(() => {
    if (!folded) view.current?.requestMeasure();
  }, [folded]);

  // A file that was just made by name is ready to type in.
  useEffect(() => {
    if (store.wantFocus !== box || !key) return;
    store.wantFocus = null;
    view.current?.focus();
  });

  return (
    <div class={`box box-${KINDS[box]}${folded ? " folded" : ""}`}>
      <div class="box-head">
        <Kind box={box} />
        {candidates.length > 1 ? (
          <select
            aria-label={t("box.choose")}
            value={path ?? ""}
            onChange={(e) => void store.open(e.currentTarget.value)}
          >
            {candidates.map((f) => (
              <option value={f.path}>{f.path}</option>
            ))}
          </select>
        ) : (
          <span class={`box-name${path ? "" : " dim"}`}>
            {path ?? `${name} · ${t("box.none")}`}
          </span>
        )}
        <span class="grow" />
        <button
          type="button"
          class="fold"
          aria-expanded={!folded}
          aria-label={t(folded ? "box.unfold" : "box.fold", { name })}
          title={t(folded ? "box.unfold" : "box.fold", { name })}
          onClick={() => store.toggleFold(box)}
        >
          <ChevronDown {...ICON} />
        </button>
      </div>
      {doc?.conflict != null && path && (
        <div class="strip warn" role="alert">
          {t("box.conflict")}
          <button
            type="button"
            class="button"
            onClick={() => void store.resolve(path, "theirs")}
          >
            {t("box.theirs")}
          </button>
          <button
            type="button"
            class="button"
            onClick={() => void store.resolve(path, "mine")}
          >
            {t("box.mine")}
          </button>
        </div>
      )}
      <div class="box-body" ref={host} />
    </div>
  );
}

interface Line {
  level: string;
  text: string;
  file: string;
  line: number;
}

function storage(action: "get" | "set" | "remove", key: string): string | null {
  try {
    if (action === "get") return localStorage.getItem(key);
    if (action === "set") localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Without storage the paused start cannot work. The preview itself still does.
  }
  return null;
}

function Preview({ store }: { store: EditorStore }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [path, setPath] = useState("/");
  const [lines, setLines] = useState<Line[]>([]);
  // The flag is set before the preview loads and cleared when the page has run its scripts.
  // A script that hangs leaves it set, and the next start opens with the preview paused.
  const flag = `maak:loading:${store.project.id}`;
  const [paused, setPaused] = useState(() => storage("get", flag) !== null);
  // path is what the frame shows. page is the last web page it showed: after a look at an image,
  // the next saved edit brings that page back.
  const live = useRef({
    ready: false,
    started: false,
    path: "/",
    page: "/",
    paused,
    miss: new Set<string>(),
  });
  const origin = store.frameOrigin;
  live.current.paused = paused;

  // Each hard load gets a new frame element. Assigning the same address to an existing frame
  // would not reload it, and a new element also drops a page that hangs.
  const [src, setSrc] = useState<{ url: string; gen: number } | null>(null);
  // A load that has not finished after four seconds is treated as stuck.
  const [stalled, setStalled] = useState(false);
  const watchdog = useRef(0);
  const watch = () => {
    clearTimeout(watchdog.current);
    setStalled(false);
    watchdog.current = window.setTimeout(() => setStalled(true), 4000);
  };
  const settled = () => {
    clearTimeout(watchdog.current);
    setStalled(false);
    storage("remove", flag);
  };
  const post = (message: object) =>
    frame.current?.contentWindow?.postMessage(message, store.frameOrigin);
  const load = (to: string) => {
    const s = live.current;
    if (s.paused) return;
    s.ready = false;
    s.started = false;
    s.path = to;
    storage("set", flag);
    watch();
    setPath(to);
    setSrc((old) => ({
      url: store.frameOrigin + to,
      gen: (old?.gen ?? 0) + 1,
    }));
  };

  useEffect(() => {
    store.preview = {
      css: (file, text) => post({ type: "css", path: file, text }),
      cssSaved: (file, rev) => {
        const s = live.current;
        if (!s.ready || s.miss.has(file)) store.preview?.reload();
        else post({ type: "css-saved", path: file, rev });
      },
      reload: () => {
        const s = live.current;
        if (!s.ready) return load(s.page);
        s.ready = false;
        storage("set", flag);
        watch();
        post({ type: "reload" });
      },
      show: (to) => {
        // A page becomes "the page on screen" at once, so a save that lands before the page
        // has reported itself reloads this page and not the one before it.
        if (/(\.html?|\/)$/i.test(to.split(/[?#]/)[0])) live.current.page = to;
        load(to);
      },
    };
    const onMessage = (e: MessageEvent) => {
      if (
        e.origin !== store.frameOrigin ||
        e.source !== frame.current?.contentWindow ||
        !e.data?.maak
      )
        return;
      const s = live.current;
      const data = e.data as { type: string; path?: string } & Line;
      if (data.type === "start") {
        s.started = true;
        s.path = s.page = data.path ?? "/";
        setPath(s.path);
        setLines([]);
      } else if (data.type === "path") {
        s.path = s.page = data.path ?? "/";
        setPath(s.path);
      } else if (data.type === "ready") {
        s.ready = true;
        s.miss.clear();
        settled();
      } else if (data.type === "css-miss" && data.path) {
        s.miss.add(data.path);
      } else if (data.type === "console") {
        setLines((old) => [
          ...old.slice(-199),
          {
            level: data.level,
            text: data.text,
            file: data.file,
            line: data.line,
          },
        ]);
      }
    };
    addEventListener("message", onMessage);
    return () => {
      removeEventListener("message", onMessage);
      clearTimeout(watchdog.current);
      store.preview = null;
    };
  }, [store]);

  // The origin changes with a rename, a new preview link, and a history snapshot.
  useEffect(() => {
    if (!paused) load(live.current.path);
  }, [origin, paused]);

  const address =
    store.project.shared || !store.project.secret
      ? store.siteUrl
      : `${location.protocol}//${store.project.name}--${store.project.secret}.${store.siteSuffix}`;

  return (
    <div class="preview">
      <div class="preview-bar">
        <input
          class="path"
          readOnly
          value={path}
          aria-label={t("preview.address")}
        />
        <button
          type="button"
          class="icon-button"
          aria-label={t("preview.reload")}
          title={t("preview.reload")}
          onClick={() => load(live.current.path)}
        >
          <RotateCw {...ICON} />
        </button>
        <a class="link" href={address + path} target="_blank" rel="noopener">
          <ExternalLink {...ICON} />
          {t("preview.open")}
        </a>
      </div>
      {store.viewing && <div class="strip">{t("preview.snapshot")}</div>}
      {stalled && !paused && (
        <div class="strip warn" role="alert">
          {t("preview.stalled")}
          <button
            type="button"
            class="button"
            onClick={() => store.freshOrigin()}
          >
            {t("preview.restart")}
          </button>
        </div>
      )}
      {paused ? (
        <div class="paused" role="alert">
          <p>{t("preview.paused")}</p>
          <button
            type="button"
            class="button accent"
            onClick={() => {
              storage("remove", flag);
              store.freshOrigin();
              setPaused(false);
            }}
          >
            {t("preview.start")}
          </button>
        </div>
      ) : (
        src && (
          <div class="frame-wrap">
            <iframe
              key={src.gen}
              ref={frame}
              src={src.url}
              title={t("preview.title")}
              onLoad={() => {
                const s = live.current;
                // A page without the helper, such as an image, cannot answer a reload message.
                if (!s.started) s.ready = false;
                s.started = false;
                settled();
              }}
            />
            {/* Covers the frame while a menu is open or a divider is dragged, so that a press
              on the preview reaches this page. */}
            <div class="frame-shield" />
          </div>
        )
      )}
      {lines.length > 0 && (
        <div class="console" role="log" aria-label={t("preview.console")}>
          <div class="console-head">
            <strong>{t("preview.console")}</strong>
            <span class="grow" />
            <button type="button" class="link" onClick={() => setLines([])}>
              {t("preview.clear")}
            </button>
          </div>
          <ol>
            {lines.map((line) => (
              <li class={`level-${line.level}`}>
                <span class="console-text">{line.text}</span>
                {line.file && (
                  <span class="dim">
                    {line.file.slice(1)}
                    {line.line ? `:${line.line}` : ""}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

interface Snapshot {
  id: string;
  created_at: number;
  changed: number;
}

function History({
  store,
  onClose,
}: {
  store: EditorStore;
  onClose: () => void;
}) {
  const [list, setList] = useState<Snapshot[] | null>(null);
  useEffect(() => {
    api<{ snapshots: Snapshot[] }>(
      "GET",
      `/api/projects/${store.project.id}/snapshots`,
    )
      .then((r) => setList(r.snapshots))
      .catch((e) => store.fail(e));
  }, []);
  return (
    <div class="tree history">
      <div class="history-head">
        <h2>{t("history.title")}</h2>
        <button type="button" class="link" onClick={onClose}>
          {t("history.close")}
        </button>
      </div>
      <p class="dim">{t("history.note")}</p>
      {store.viewing && (
        <button
          type="button"
          class="button accent"
          onClick={async () => {
            await store.restore(store.viewing!);
            onClose();
          }}
        >
          {t("history.restore")}
        </button>
      )}
      {list === null ? (
        <p class="dim">{t("app.loading")}</p>
      ) : list.length === 0 ? (
        <p class="dim">{t("history.empty")}</p>
      ) : (
        <ul class="rows">
          {list.map((snap) => (
            <li class={`row${store.viewing === snap.id ? " selected" : ""}`}>
              <button
                type="button"
                class="row-name"
                aria-pressed={store.viewing === snap.id}
                onClick={() => store.view(snap.id)}
              >
                {when(snap.created_at)}
                <span class="dim">
                  {" "}
                  ·{" "}
                  {snap.changed
                    ? t("history.changed", { count: snap.changed })
                    : t("history.same")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
