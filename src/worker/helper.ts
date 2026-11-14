// The helper script. It exists only in preview-alias responses: never in a stored file,
// never in the ZIP and never on a shared site. It talks to the editor's origin and to no one else.

function helperSource(EDITOR: string) {
  const parentWindow = window.parent;
  if (parentWindow === window) return;
  const send = (message: object) => parentWindow.postMessage({ maak: true, ...message }, EDITOR);
  const here = () => location.pathname + location.search + location.hash;

  // Console: forward output and uncaught errors, with file name and line.
  const show = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  };
  const caller = (): { file: string; line: number } => {
    for (const line of (new Error().stack ?? "").split("\n")) {
      const m = /(https?:\/\/\S+?):(\d+):\d+\)?$/.exec(line.trim());
      if (m && !m[1].includes("maak-helper.js")) return { file: new URL(m[1]).pathname, line: Number(m[2]) };
    }
    return { file: "", line: 0 };
  };
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      send({ type: "console", level, text: args.map(show).join(" "), ...caller() });
    };
  }
  addEventListener("error", (e) => {
    if (!(e instanceof ErrorEvent)) return;
    let file = "";
    try {
      file = e.filename ? new URL(e.filename).pathname : "";
    } catch {
      file = "";
    }
    send({ type: "console", level: "error", text: e.message, file, line: e.lineno || 0 });
  });
  addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    send({ type: "console", level: "error", text: `Uncaught (in promise) ${show(e.reason)}`, file: "", line: 0 });
  });

  // Address: tell the editor which path is showing.
  send({ type: "start", path: here() });
  addEventListener("hashchange", () => send({ type: "path", path: here() }));
  addEventListener("popstate", () => send({ type: "path", path: here() }));

  // Reload: keep the scroll position across the reload that follows a save.
  const scrollKey = `maak-scroll:${location.pathname}`;
  const saved = sessionStorage.getItem(scrollKey);
  if (saved) {
    sessionStorage.removeItem(scrollKey);
    const [x, y] = saved.split(",").map(Number);
    addEventListener("load", () => scrollTo(x, y));
    addEventListener("DOMContentLoaded", () => scrollTo(x, y));
  }

  // Instant CSS: a <style> element stands in for the stylesheet while the save is on its way.
  const linkFor = (path: string): HTMLLinkElement | null => {
    for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]'))) {
      const url = new URL(link.href, location.href);
      if (url.origin === location.origin && decodeURIComponent(url.pathname) === `/${path}`) return link;
    }
    return null;
  };
  const standIn = (path: string) =>
    document.querySelector<HTMLStyleElement>(`style[data-maak="${CSS.escape(path)}"]`);

  addEventListener("message", (e) => {
    if (e.origin !== EDITOR || e.source !== parentWindow) return;
    const data = e.data as { type?: string; path?: string; text?: string; rev?: number };
    if (data.type === "reload") {
      sessionStorage.setItem(scrollKey, `${scrollX},${scrollY}`);
      location.reload();
    } else if (data.type === "css" && typeof data.path === "string") {
      const link = linkFor(data.path);
      if (!link) return send({ type: "css-miss", path: data.path });
      let style = standIn(data.path);
      if (!style) {
        style = document.createElement("style");
        style.dataset.maak = data.path;
        link.insertAdjacentElement("afterend", style);
      }
      style.textContent = data.text ?? "";
      link.disabled = true;
    } else if (data.type === "css-saved" && typeof data.path === "string") {
      // The saved file takes over again, so url() paths inside it resolve from its own folder.
      const link = linkFor(data.path);
      const style = standIn(data.path);
      if (!link) return send({ type: "css-miss", path: data.path });
      const url = new URL(link.href, location.href);
      url.searchParams.set("maak", String(data.rev ?? Date.now()));
      const fresh = link.cloneNode() as HTMLLinkElement;
      fresh.disabled = false;
      fresh.href = url.pathname + url.search;
      fresh.addEventListener("load", () => {
        link.remove();
        // A newer keystroke may have filled the stand-in again while this file was loading.
        if (style && style.dataset.rev === String(data.rev)) style.remove();
      });
      if (style) style.dataset.rev = String(data.rev);
      link.insertAdjacentElement("afterend", fresh);
    }
  });

  // Ready: sent after the page's own scripts ran. A script that hangs never gets here,
  // and the editor uses that to open with the preview paused next time.
  const ready = () => send({ type: "ready", path: here() });
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", ready);
  else ready();
}

/**
 * The script element that goes into alias HTML, with the editor's origin filled in.
 * The source travels as one string on one line, so line numbers in the student's page stay true.
 * __name is defined because the bundler wraps named functions in a call to it.
 */
export function helperTag(editorOrigin: string): string {
  const source = `(()=>{const __name=(f)=>f;(${helperSource.toString()})(${JSON.stringify(editorOrigin)})})()\n//# sourceURL=maak-helper.js`;
  return `<script>(0,eval)(${JSON.stringify(source).replace(/</g, "\\u003c")})</script>`;
}

/**
 * Puts the helper into an HTML document. It goes right after the doctype so the page keeps
 * standards mode and the helper runs before any script of the page.
 */
export function injectHelper(html: string, editorOrigin: string): string {
  const tag = helperTag(editorOrigin);
  const doctype = /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype[0].length) + tag + html.slice(doctype[0].length);
  return tag + html;
}
