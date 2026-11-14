// The ZIP is built in the browser. It holds one folder named after the project, with the files
// exactly as stored: no maak.io files, no helper script, no configuration.

import { type Zippable, zipSync } from "fflate";
import { type FileRow, type ProjectInfo, api, readBytes } from "./api";
import type { EditorStore } from "./store";

type Entries = Record<string, [Uint8Array, { mtime: number; level: 0 | 6 }]>;

const COMPRESSED = /\.(png|jpe?g|gif|webp|avif|woff2?|mp[34]|m4a|ogg|webm|mov|glb|pdf)$/i;

async function addProject(entries: Entries, project: ProjectInfo, files: FileRow[], text: (path: string) => string | null) {
  for (const file of files) {
    const name = `${project.name}/${file.path}`;
    if (file.kind === "folder") {
      // An entry that ends in a slash is a folder, so an empty folder survives the download.
      entries[`${name}/`] = [new Uint8Array(0), { mtime: file.updated_at, level: 0 }];
      continue;
    }
    const open = text(file.path);
    const bytes = open !== null ? new TextEncoder().encode(open) : (await readBytes(project.id, file.path)).bytes;
    entries[name] = [bytes, { mtime: file.updated_at, level: COMPRESSED.test(file.path) ? 0 : 6 }];
  }
}

function save(entries: Entries, name: string) {
  const blob = new Blob([zipSync(entries as Zippable) as Uint8Array<ArrayBuffer>], { type: "application/zip" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${name}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

/** Text that is open in a box comes from the editor, so the ZIP matches what is on screen. */
export async function downloadProject(store: EditorStore): Promise<void> {
  const entries: Entries = {};
  await addProject(entries, store.project, store.files, (path) => store.docs.get(path)?.text ?? null);
  save(entries, store.project.name);
}

/** One ZIP with a folder per project. It doubles as the data export a person may ask for. */
export async function downloadAll(): Promise<void> {
  const entries: Entries = {};
  const { projects } = await api<{ projects: ProjectInfo[] }>("GET", "/api/projects");
  for (const project of projects) {
    const { files } = await api<{ files: FileRow[] }>("GET", `/api/projects/${project.id}/files`);
    await addProject(entries, project, files, () => null);
  }
  save(entries, "maak");
}
