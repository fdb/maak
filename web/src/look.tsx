// Light and dark mode. The choice is kept on this computer; without one, the system setting decides.

import { Moon, Sun } from "lucide-preact";
import { useEffect, useReducer } from "preact/hooks";
import { t } from "./i18n";

export type Theme = "light" | "dark";
const listeners = new Set<() => void>();
let theme: Theme = "light";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A private window may refuse storage. The choice then lasts for this visit.
  }
}

function apply(): void {
  document.documentElement.dataset.theme = theme;
  for (const fn of listeners) fn();
}

export function initTheme(): void {
  const stored = read("maak:theme");
  theme = stored === "dark" || stored === "light" ? stored : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  apply();
}

export function setTheme(next: Theme): void {
  theme = next;
  write("maak:theme", next);
  apply();
}

function useTheme(): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const fn = () => bump(0);
    listeners.add(fn);
    return () => void listeners.delete(fn);
  }, []);
}

/** The dark mode switch. It is a switch, so a screen reader hears its state. */
export function ThemeToggle() {
  useTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      class="icon-button"
      role="switch"
      aria-checked={dark}
      aria-label={t("theme.dark")}
      title={t(dark ? "theme.toLight" : "theme.toDark")}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}
    </button>
  );
}
