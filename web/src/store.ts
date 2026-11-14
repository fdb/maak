// The state of one open project: its files, the three boxes, and the save pipeline.
// Components subscribe and re-render; CodeMirror keeps its own text and reports changes here.

import { LIMITS, baseOf, boxOf, contentType, ext, parentOf, pathError } from "../../src/shared/rules";
import { ApiError, type FileRow, type ProjectInfo, type Saved, api, readBytes, readText, saveFile, uploadFile } from "./api";
import * as pending from "./pending";
import { type BigImage, inspect, shrink } from "./resize";

export interface Doc {
  text: string;
  rev: number;
  dirty: boolean;
  saving: boolean;
  /** Set when the server refused a save because the file changed elsewhere: the server's revision. */
  conflict: number | null;
  /** Goes up when the text is replaced from outside the editor box. */
  external: number;
  timer: number;
}

/** What the store needs from the preview. The Preview component provides it. */
export interface PreviewLink {
  css(path: string, text: string): void;
  cssSaved(path: string, rev: number): void;
  reload(): void;
  show(path: string): void;
}

export type Status = "saved" | "saving" | "offline";

const SAVE_DELAY = 400;
const DEFAULTS = ["index.html", "style.css", "script.js"];

export class EditorStore {
  files: FileRow[] = [];
  boxes: (string | null)[] = [null, null, null];
  folded = [false, false, true];
  docs = new Map<string, Doc>();
  uploads = new Map<string, number>();
  selected: string | null = null;
  offline = false;
  signedOut = false;
  /** An error code to show once, such as "type" or "file-too-large". */
  notice: string | null = null;
  /** The history snapshot that the preview shows, if any. */
  viewing: string | null = null;
  flash = 0;
  /** Set while the editor asks what to do with images that are too big. */
  ask: { files: File[]; folder: string; big: BigImage[]; done: (paths: string[]) => void } | null = null;
  preview: PreviewLink | null = null;
  /** The box whose code should get the keyboard next, after a file was made by name. */
  wantFocus: number | null = null;
  ready = false;

  private listeners = new Set<() => void>();
  private retries = 0;
  private retryTimer = 0;

  /** Which numbered twin of the alias the preview uses. 0 is the plain alias. */
  twin = 0;

  constructor(
    public project: ProjectInfo,
    public siteSuffix: string,
  ) {
    try {
      this.twin = Number(localStorage.getItem(`maak:twin:${project.id}`)) || 0;
    } catch {
      this.twin = 0;
    }
  }

  get readOnly(): boolean {
    return !this.project.owner;
  }

  get status(): Status {
    if (this.offline || this.signedOut) return "offline";
    for (const doc of this.docs.values()) if (doc.dirty || doc.saving) return "saving";
    return this.uploads.size ? "saving" : "saved";
  }

  get unsaved(): boolean {
    for (const doc of this.docs.values()) if (doc.dirty) return true;
    return false;
  }

  /** The origin of the frame: the private alias for the owner, the shared site for a reader. */
  get frameOrigin(): string {
    const { name, secret } = this.project;
    const twin = this.twin ? `--${this.twin}` : "";
    const label = !secret ? name : this.viewing ? `0--${secret}--${this.viewing}` : `${name}--${secret}${twin}`;
    return `${location.protocol}//${label}.${this.siteSuffix}`;
  }

  get siteUrl(): string {
    return `${location.protocol}//${this.project.name}.${this.siteSuffix}`;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  fail(error: unknown): void {
    this.notice = error instanceof ApiError ? error.code : "server";
    this.emit();
  }

  filesOfBox(box: number): FileRow[] {
    return this.files.filter((f) => f.kind === "file" && boxOf(f.path) === box);
  }

  async load(): Promise<void> {
    const ref = this.project.id;
    this.files = (await api<{ files: FileRow[] }>("GET", `/api/projects/${ref}/files`)).files;
    const kept = this.readOnly ? [] : await pending.list(ref);
    for (let box = 0; box < 3; box++) {
      const candidates = this.filesOfBox(box).filter((f) => f.size <= LIMITS.text);
      const first = candidates.find((f) => f.path === DEFAULTS[box]) ?? candidates.find((f) => !f.path.includes("/")) ?? candidates[0];
      this.boxes[box] = first?.path ?? null;
    }
    await Promise.all(this.boxes.map((path) => (path ? this.ensureDoc(path) : null)));
    // The JS box stays folded until the file is used.
    const script = this.boxes[2] ? this.docs.get(this.boxes[2]) : null;
    this.folded = [this.boxes[0] === null, this.boxes[1] === null, !script || script.text.trim() === ""];

    // Changes that never reached the server come back and are sent again.
    for (const item of kept) {
      const row = this.files.find((f) => f.path === item.path);
      if (row?.kind === "folder" || boxOf(item.path) === null) {
        void pending.drop(ref, item.path);
        continue;
      }
      if (row) await this.ensureDoc(item.path);
      const doc = this.docs.get(item.path) ?? this.blank(item.path);
      if (doc.text === item.text) {
        void pending.drop(ref, item.path);
        continue;
      }
      doc.text = item.text;
      doc.rev = item.rev;
      doc.dirty = true;
      doc.external++;
      void this.flush(item.path);
    }
    // Opening a project takes a snapshot, so History always has a way back to "before today".
    if (!this.readOnly) void api("POST", `/api/projects/${ref}/snapshots`).catch(() => null);
    this.ready = true;
    this.emit();
  }

  private blank(path: string): Doc {
    const doc: Doc = { text: "", rev: 0, dirty: false, saving: false, conflict: null, external: 0, timer: 0 };
    this.docs.set(path, doc);
    return doc;
  }

  private async ensureDoc(path: string): Promise<Doc> {
    const existing = this.docs.get(path);
    if (existing) return existing;
    const { text, rev } = await readText(this.project.id, path);
    const doc = this.docs.get(path) ?? this.blank(path);
    doc.text = text;
    doc.rev = rev;
    return doc;
  }

  /** A click in the tree: text opens in the box of its kind, anything else shows in the preview. */
  async open(path: string): Promise<void> {
    const row = this.files.find((f) => f.path === path);
    if (!row || row.kind === "folder") return;
    this.selected = path;
    const box = boxOf(path);
    if (box === null) {
      this.preview?.show(`/${path.split("/").map(encodeURIComponent).join("/")}`);
      return this.emit();
    }
    if (row.size > LIMITS.text) {
      this.notice = "too-large-to-edit";
      return this.emit();
    }
    try {
      await this.ensureDoc(path);
    } catch (error) {
      return this.fail(error);
    }
    this.boxes[box] = path;
    this.folded[box] = false;
    this.emit();
    // The code of a page and the page itself go together: opening about.html shows about.html.
    if (/\.html?$/i.test(path)) this.preview?.show(`/${path.split("/").map(encodeURIComponent).join("/")}`);
  }

  toggleFold(box: number): void {
    this.folded[box] = !this.folded[box];
    this.emit();
  }

  /** Every keystroke lands here. The file is sent 400 ms after the last one. */
  edit(path: string, text: string): void {
    const doc = this.docs.get(path);
    if (!doc || this.readOnly || doc.text === text) return;
    const before = this.status;
    doc.text = text;
    doc.dirty = true;
    void pending.keep({ project: this.project.id, path, text, rev: doc.rev });
    if (ext(path) === "css") this.preview?.css(path, text);
    clearTimeout(doc.timer);
    doc.timer = window.setTimeout(() => void this.flush(path), SAVE_DELAY);
    if (this.status !== before) this.emit();
  }

  async flush(path: string): Promise<void> {
    const doc = this.docs.get(path);
    if (!doc || !doc.dirty || doc.saving || doc.conflict !== null) return;
    clearTimeout(doc.timer);
    doc.saving = true;
    const text = doc.text;
    let saved: Saved;
    try {
      saved = await saveFile(this.project.id, path, text, doc.rev);
    } catch (error) {
      doc.saving = false;
      const e = error instanceof ApiError ? error : new ApiError(0, "offline");
      if (e.status === 412) {
        // A save of this same text may have landed without its answer, for example when the
        // tab was reloaded mid-request. That is no conflict: take the server's revision.
        const theirs = await readText(this.project.id, path).catch(() => null);
        if (theirs && theirs.text === text) {
          doc.rev = theirs.rev;
          if (doc.text === text) {
            doc.dirty = false;
            void pending.drop(this.project.id, path);
          } else {
            doc.timer = window.setTimeout(() => void this.flush(path), SAVE_DELAY);
          }
        } else {
          doc.conflict = Number(e.data.rev ?? 0);
        }
      } else if (e.status === 401) {
        this.signedOut = true;
        this.retryLater();
      } else if (e.status === 0 || e.status >= 500 || e.status === 429) {
        this.offline = true;
        this.retryLater();
      } else {
        // The server will keep refusing this text, so do not retry until the next edit.
        doc.dirty = false;
        this.notice = e.code;
      }
      return this.emit();
    }
    doc.saving = false;
    doc.rev = saved.rev;
    this.offline = false;
    this.signedOut = false;
    this.retries = 0;
    this.noteSaved(path, saved);
    if (doc.text === text) {
      doc.dirty = false;
      void pending.drop(this.project.id, path);
    } else {
      void pending.keep({ project: this.project.id, path, text: doc.text, rev: doc.rev });
      doc.timer = window.setTimeout(() => void this.flush(path), SAVE_DELAY);
    }
    // CSS was already applied on the keystroke. HTML and JS show after the save.
    if (ext(path) === "css") this.preview?.cssSaved(path, saved.rev);
    else this.preview?.reload();
    this.emit();
  }

  private noteSaved(path: string, saved: Saved): void {
    const row = this.files.find((f) => f.path === path);
    if (row) Object.assign(row, saved);
    else {
      this.files.push({ path, kind: "file", ...saved });
      this.files.sort((a, b) => (a.path < b.path ? -1 : 1));
    }
  }

  /** Retries with growing pauses: 1 s, 2 s, 4 s, up to 30 s. */
  private retryLater(): void {
    clearTimeout(this.retryTimer);
    const wait = Math.min(30_000, 1000 * 2 ** this.retries++);
    this.retryTimer = window.setTimeout(() => this.flushAll(), wait);
  }

  flushAll(): void {
    for (const path of this.docs.keys()) void this.flush(path);
  }

  /** "Load that version" takes the server's file. "Keep mine" saves over it. */
  async resolve(path: string, keep: "mine" | "theirs"): Promise<void> {
    const doc = this.docs.get(path);
    if (!doc || doc.conflict === null) return;
    if (keep === "mine") {
      doc.rev = doc.conflict;
      doc.conflict = null;
      return this.flush(path);
    }
    try {
      const { text, rev } = await readText(this.project.id, path);
      Object.assign(doc, { text, rev, dirty: false, conflict: null, external: doc.external + 1 });
      void pending.drop(this.project.id, path);
      this.preview?.reload();
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }

  async refresh(): Promise<void> {
    this.files = (await api<{ files: FileRow[] }>("GET", `/api/projects/${this.project.id}/files`)).files;
    const paths = new Set(this.files.map((f) => f.path));
    this.boxes = this.boxes.map((path) => (path && paths.has(path) ? path : null));
    for (const path of [...this.docs.keys()]) if (!paths.has(path)) this.docs.delete(path);
    this.emit();
  }

  private check(path: string, file: boolean): string | null {
    const problem = pathError(path);
    if (problem) return `path-${problem}`;
    if (file && !contentType(path)) return "type";
    if (this.files.some((f) => f.path === path)) return "exists";
    return null;
  }

  async createFile(path: string): Promise<boolean> {
    const problem = this.check(path, true);
    if (problem) return this.refuse(problem);
    try {
      await saveFile(this.project.id, path, "", 0);
      await this.refresh();
      this.wantFocus = boxOf(path);
      await this.open(path);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  async createFolder(path: string): Promise<boolean> {
    const problem = this.check(path, false);
    if (problem) return this.refuse(problem);
    try {
      await api("PUT", `/api/projects/${this.project.id}/files/${path.split("/").map(encodeURIComponent).join("/")}?folder=1`);
      await this.refresh();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  private refuse(code: string): false {
    this.notice = code;
    this.emit();
    return false;
  }

  /** Rename and move are one action: the new path may name another folder. */
  async move(from: string, to: string): Promise<boolean> {
    if (from === to) return true;
    const row = this.files.find((f) => f.path === from);
    if (!row) return false;
    const problem = this.check(to, row.kind === "file");
    if (problem) return this.refuse(problem);
    try {
      // Unsaved text must reach the old path before the path changes.
      await Promise.all([...this.docs.keys()].filter((p) => p === from || p.startsWith(`${from}/`)).map((p) => this.flush(p)));
      await api("POST", `/api/projects/${this.project.id}/move`, { from, to });
    } catch (error) {
      this.fail(error);
      return false;
    }
    const moved = (path: string) => (path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : path);
    this.docs = new Map([...this.docs].map(([path, doc]) => [moved(path), doc]));
    this.boxes = this.boxes.map((path) => (path ? moved(path) : null));
    // A file that changes kind, such as notes.txt to notes.css, leaves its box.
    this.boxes = this.boxes.map((path, box) => (path && boxOf(path) === box ? path : null));
    if (this.selected) this.selected = moved(this.selected);
    await this.refresh();
    this.preview?.reload();
    return true;
  }

  /** Copies a file to a new path and opens the copy. Text that is open in a box is copied as it is on screen. */
  async duplicate(from: string, to: string): Promise<boolean> {
    const problem = this.check(to, true);
    if (problem) return this.refuse(problem);
    try {
      const open = this.docs.get(from);
      const body = open ? open.text : new Blob([(await readBytes(this.project.id, from)).bytes as Uint8Array<ArrayBuffer>]);
      await saveFile(this.project.id, to, body, 0);
      await this.refresh();
      this.wantFocus = boxOf(to);
      await this.open(to);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await api("DELETE", `/api/projects/${this.project.id}/files/${path.split("/").map(encodeURIComponent).join("/")}`);
      for (const p of [...this.docs.keys()]) {
        if (p === path || p.startsWith(`${path}/`)) {
          clearTimeout(this.docs.get(p)!.timer);
          this.docs.delete(p);
          void pending.drop(this.project.id, p);
        }
      }
      await this.refresh();
      this.preview?.reload();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * The start of every upload. When the batch holds images that are too big, the editor first
   * asks what size they should get; otherwise the upload starts at once.
   * Resolves with the paths that were uploaded: none when the person cancels.
   */
  async offer(list: File[], folder: string): Promise<string[]> {
    const big = await inspect(list);
    if (!big.length) return this.upload(list, folder);
    return new Promise((done) => {
      this.ask?.done([]);
      this.ask = { files: list, folder, big, done };
      this.emit();
    });
  }

  /**
   * The answer to that question: a longest side in pixels, null to keep the originals, or
   * "cancel". One answer goes for the whole batch, so every image is treated the same.
   */
  async answer(pixels: number | null | "cancel"): Promise<void> {
    const ask = this.ask;
    if (!ask) return;
    this.ask = null;
    this.emit();
    if (pixels === "cancel") return ask.done([]);
    const files = pixels === null ? ask.files : await Promise.all(ask.files.map((file) => shrink(file, pixels)));
    ask.done(await this.upload(files, ask.folder));
  }

  /** Uploads files into a folder, one request per file, with progress in the tree. */
  async upload(list: File[], folder: string): Promise<string[]> {
    const uploaded: string[] = [];
    for (const file of list) {
      const path = folder ? `${folder}/${file.name}` : file.name;
      const problem = pathError(path) ? `path-${pathError(path)}` : !contentType(path) ? "type" : file.size > LIMITS.file ? "file-too-large" : null;
      if (problem) {
        this.notice = problem;
        this.emit();
        continue;
      }
      this.uploads.set(path, 0);
      this.emit();
      try {
        const saved = await uploadFile(this.project.id, path, file, (done) => {
          this.uploads.set(path, done);
          this.emit();
        });
        this.noteSaved(path, saved);
        uploaded.push(path);
        // An uploaded text file replaces what a box may be showing.
        const doc = this.docs.get(path);
        if (doc) {
          const { text, rev } = await readText(this.project.id, path);
          Object.assign(doc, { text, rev, dirty: false, conflict: null, external: doc.external + 1 });
        }
      } catch (error) {
        this.notice = error instanceof ApiError ? error.code : "server";
      }
      this.uploads.delete(path);
      this.emit();
    }
    await this.refresh().catch((error) => this.fail(error));
    this.preview?.reload();
    return uploaded;
  }

  /** Shows a history snapshot in the preview, or goes back to the live files with null. */
  view(snapshot: string | null): void {
    this.viewing = snapshot;
    this.emit();
  }

  async restore(snapshot: string): Promise<void> {
    try {
      await api("POST", `/api/projects/${this.project.id}/snapshots/${snapshot}/restore`);
      for (const doc of this.docs.values()) clearTimeout(doc.timer);
      const open = this.boxes.filter((p): p is string => p !== null);
      const old = this.docs;
      this.docs = new Map();
      this.viewing = null;
      await this.refresh();
      for (const path of open) {
        if (!this.files.some((f) => f.path === path)) continue;
        const doc = await this.ensureDoc(path);
        doc.external = (old.get(path)?.external ?? 0) + 1;
        void pending.drop(this.project.id, path);
      }
      this.boxes = this.boxes.map((path, box) => path ?? this.filesOfBox(box)[0]?.path ?? null);
      await Promise.all(this.boxes.map((path) => (path ? this.ensureDoc(path) : null)));
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }

  async patch(change: { name?: string; shared?: boolean; resetSecret?: boolean }): Promise<boolean> {
    try {
      const { project } = await api<{ project: ProjectInfo }>("PATCH", `/api/projects/${this.project.id}`, change);
      this.project = project;
      this.emit();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  /**
   * Moves the preview to the next numbered twin of the alias. A preview that hung keeps its
   * browser process stuck, and a new host name is the only way to get a fresh one.
   */
  freshOrigin(): void {
    this.twin = (this.twin % 999) + 1;
    try {
      localStorage.setItem(`maak:twin:${this.project.id}`, String(this.twin));
    } catch {
      // Without storage the number lasts for this visit.
    }
    this.emit();
  }

  /** Cmd/Ctrl+S flashes the status and does nothing else. */
  flashStatus(): void {
    this.flash++;
    this.emit();
  }
}

export { baseOf, parentOf };
