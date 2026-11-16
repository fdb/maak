// Rules that the Worker enforces and the editor shows. Both import this file.

const MB = 1024 * 1024;

// Sign-up is open to anyone with a Google account, so these hold for everyone.
export const LIMITS = {
  file: 5 * MB,
  project: 25 * MB,
  files: 150,
  projects: 20,
  /** Everything a person's projects hold in storage: files, history and the trash. */
  person: 100 * MB,
  /** Segments of a path, the file name included. */
  depth: 8,
  text: 1 * MB,
  sizeHint: 500_000,
};

export const RESERVED = new Set([
  "www", "api", "app", "admin", "mail", "static", "copy", "login", "logout", "auth", "assets",
  "help", "about", "terms", "privacy", "report", "abuse", "support", "status", "blog", "docs",
  "cdn", "ftp", "smtp", "imap", "pop", "ns1", "ns2", "mx", "dev", "test", "staging", "preview",
  "maak", "root", "null", "undefined", "account", "accounts", "security", "postmaster", "webmaster",
]);

export type NameError = "length" | "chars" | "reserved";

/** A project name is also a DNS label, and "--" separates the name from the preview secret. */
export function nameError(name: string): NameError | null {
  if (name.length < 3 || name.length > 40) return "length";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return "chars";
  if (RESERVED.has(name)) return "reserved";
  return null;
}

export type PathError = "empty" | "long" | "deep" | "dots" | "backslash" | "leading-dot" | "control" | "slash";

export function pathError(path: string): PathError | null {
  if (!path) return "empty";
  if (path.length > 255) return "long";
  if (path.includes("\\")) return "backslash";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "control";
  const parts = path.split("/");
  for (const part of parts) {
    if (!part) return "slash";
    if (part.includes("..")) return "dots";
    if (part.startsWith(".")) return "leading-dot";
  }
  if (parts.length > LIMITS.depth) return "deep";
  return null;
}

/** A quiet hint in the tree: this name works, but it is easy to mistype in a src or href. */
export function pathHint(path: string): boolean {
  return /[A-Z\s]/.test(path);
}

export const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "model/obj",
  mtl: "model/mtl",
  stl: "model/stl",
};

export function ext(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function contentType(path: string): string | null {
  return TYPES[ext(path)] ?? null;
}

const BOXES: Record<string, 0 | 1 | 2> = {
  html: 0, htm: 0, svg: 0, md: 0, txt: 0, xml: 0, csv: 0,
  css: 1,
  js: 2, mjs: 2, json: 2, webmanifest: 2,
};

/** Which of the three boxes opens this file. null means it is not a text file. */
export function boxOf(path: string): 0 | 1 | 2 | null {
  return BOXES[ext(path)] ?? null;
}

export function isImage(path: string): boolean {
  return (TYPES[ext(path)] ?? "").startsWith("image/");
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

const ADJECTIVES = [
  "groene", "blauwe", "rode", "gele", "snelle", "stille", "kleine", "grote", "vrolijke", "dappere",
  "slimme", "zachte", "wilde", "lichte", "warme", "koele", "ronde", "jonge", "vlugge", "trotse",
  "paarse", "oranje", "zilveren", "gouden", "nieuwe", "rustige", "blije", "sterke", "lange", "frisse",
];
const NOUNS = [
  "vos", "uil", "egel", "otter", "merel", "haas", "wolk", "boom", "fiets", "molen",
  "tulp", "maan", "ster", "brug", "golf", "vis", "bij", "kraai", "zwaan", "specht",
  "berg", "rivier", "toren", "tuin", "vlinder", "kikker", "mus", "eik", "duin", "boot",
];

/** Two Dutch words, such as groene-vos. random() returns a number in [0, 1). */
export function generateName(random: () => number = Math.random): string {
  const pick = (list: string[]) => list[Math.floor(random() * list.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}
