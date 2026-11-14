// Changed files that the server has not confirmed yet, kept in IndexedDB.
// They survive a closed tab and a lost connection. Every call is safe to fail:
// a private window may have no IndexedDB, and the editor must work without it.

export interface Pending {
  project: string;
  path: string;
  text: string;
  /** The revision the text was based on. */
  rev: number;
}

let opened: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  opened ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open("maak", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("pending");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opened;
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = work(db.transaction("pending", mode).objectStore("pending"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

const key = (project: string, path: string) => `${project}\n${path}`;

export function keep(item: Pending): Promise<unknown> {
  return run("readwrite", (s) => s.put(item, key(item.project, item.path)));
}

export function drop(project: string, path: string): Promise<unknown> {
  return run("readwrite", (s) => s.delete(key(project, path)));
}

export async function list(project: string): Promise<Pending[]> {
  const all = await run("readonly", (s) => s.getAll(IDBKeyRange.bound(`${project}\n`, `${project}\n￿`)));
  return (all as Pending[] | null) ?? [];
}
