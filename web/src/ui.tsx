// Small shared pieces: navigation without page loads, a menu, a popover, and a store hook.

import type { ComponentChildren, JSX } from "preact";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "preact/hooks";

/**
 * Loads a part of the editor that is split off from the first page. A deploy replaces every file,
 * so a tab opened before it asks for a part that is gone; one reload then gets the new parts.
 */
export function loadPart<T>(load: () => Promise<T>): Promise<T> {
  return load().catch((error) => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem("maak:reloaded") ?? 0);
      sessionStorage.setItem("maak:reloaded", String(Date.now()));
    } catch {
      // Without storage there is no guard against a loop, so do not reload.
      throw error;
    }
    if (Date.now() - last > 60_000) location.reload();
    throw error;
  });
}

export function go(path: string, replace = false): void {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function A(props: JSX.HTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      {...props}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        go(props.href);
      }}
    />
  );
}

export function useStore(store: { subscribe(fn: () => void): () => void }): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const stop = store.subscribe(() => bump(0));
    // The store may have changed between the first render and this subscription.
    bump(0);
    return stop;
  }, [store]);
}

/**
 * Closes on Escape and on a press outside. Returns focus to the button on Escape.
 *
 * A press inside the preview never reaches this page, because the preview is another page in a
 * frame. While a menu is open an invisible layer covers the frame (see body.menu-open in
 * style.css), so a press on the preview closes the menu like any other.
 */
function useDismiss(open: boolean, close: () => void, root: { current: HTMLElement | null }, button: { current: HTMLElement | null }) {
  // A layout effect: the listeners exist from the moment the menu is on screen.
  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      button.current?.focus();
    };
    // Touch and mouse are listened to as well as pointer events, for browsers that hold
    // pointer events back on a tap.
    const presses = ["pointerdown", "touchstart", "mousedown"];
    for (const type of presses) addEventListener(type, onDown, { passive: true });
    addEventListener("keydown", onKey);
    document.body.classList.add("menu-open");
    return () => {
      for (const type of presses) removeEventListener(type, onDown);
      removeEventListener("keydown", onKey);
      document.body.classList.remove("menu-open");
    };
  }, [open]);
}

export interface MenuItem {
  label: string;
  icon?: ComponentChildren;
  run: () => void;
}

export function Menu(props: { label: ComponentChildren; title?: string; items: MenuItem[]; class?: string; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), root, button);
  useEffect(() => {
    if (open) list.current?.querySelector("button")?.focus();
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    if (!open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const buttons = [...(list.current?.querySelectorAll("button") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(at + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };

  return (
    <span class="menu" ref={root} onKeyDown={onKey}>
      <button
        ref={button}
        type="button"
        class={props.class ?? "button"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.title}
        title={props.title}
        onClick={() => setOpen(!open)}
      >
        {props.label}
      </button>
      {open && (
        <div class={`popup popup-${props.align ?? "right"}`} role="menu" ref={list}>
          {props.items.map((item) => (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                button.current?.focus();
                item.run();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export function Popover(props: { label: ComponentChildren; class?: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismiss(open, () => setOpen(false), root, button);
  return (
    <span class="menu" ref={root}>
      <button ref={button} type="button" class={props.class ?? "button"} aria-expanded={open} onClick={() => setOpen(!open)}>
        {props.label}
      </button>
      {open && <div class="popup popup-right popover">{props.children}</div>}
    </span>
  );
}

/** A button that copies text and says so for a moment. */
export function CopyButton(props: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      class="button"
      onClick={async () => {
        await navigator.clipboard.writeText(props.text).catch(() => null);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <span aria-live="polite">{copied ? props.done : props.label}</span>
    </button>
  );
}
