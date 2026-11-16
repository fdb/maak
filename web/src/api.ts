// Calls to the Worker. A failed call throws ApiError with the server's error code.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public data: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export interface Me {
  signup: "open" | "closed";
  user: { email: string; name: string; lang: string; admin: boolean } | null;
  siteSuffix: string;
  contact: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  shared: boolean;
  owner: boolean;
  secret?: string;
  /** Set when an admin blocked sharing; the reason they gave. Only the owner gets it. */
  blocked?: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface FileRow {
  path: string;
  kind: "file" | "folder";
  hash: string;
  size: number;
  rev: number;
  updated_at: number;
}

export interface Saved {
  rev: number;
  hash: string;
  size: number;
  updated_at: number;
}

async function parse(res: Response): Promise<any> {
  if (res.ok) return res.json();
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  throw new ApiError(res.status, typeof data.error === "string" ? data.error : "server", data);
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: method === "GET" ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "offline");
  }
  return parse(res);
}

export function fileUrl(project: string, path: string): string {
  return `/api/projects/${project}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export async function readBytes(project: string, path: string): Promise<{ bytes: Uint8Array; rev: number }> {
  let res: Response;
  try {
    res = await fetch(fileUrl(project, path));
  } catch {
    throw new ApiError(0, "offline");
  }
  if (!res.ok) await parse(res);
  return { bytes: new Uint8Array(await res.arrayBuffer()), rev: Number(res.headers.get("X-Rev")) };
}

export async function readText(project: string, path: string): Promise<{ text: string; rev: number }> {
  const { bytes, rev } = await readBytes(project, path);
  return { text: new TextDecoder().decode(bytes), rev };
}

/** Saves a whole file. rev is the revision last seen; leave it out to overwrite. */
export async function saveFile(project: string, path: string, body: string | Blob, rev?: number): Promise<Saved> {
  let res: Response;
  try {
    res = await fetch(fileUrl(project, path), {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", ...(rev === undefined ? {} : { "If-Match": String(rev) }) },
      body,
    });
  } catch {
    throw new ApiError(0, "offline");
  }
  return parse(res);
}

/** Uploads one file and reports progress from 0 to 1. fetch cannot report upload progress, so this uses XHR. */
export function uploadFile(project: string, path: string, file: Blob, onProgress: (done: number) => void): Promise<Saved> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", fileUrl(project, path));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(0, "offline"));
    xhr.onload = () => {
      let data: any = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, typeof data.error === "string" ? data.error : "server", data));
    };
    xhr.send(file);
  });
}
