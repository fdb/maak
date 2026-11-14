// Photos from a phone are far larger than a web page needs. The editor offers to make them
// smaller before the upload. The resize happens in the browser, so the large file never
// reaches the server.

/** An image counts as too big when its longest side or its file size is over these. */
export const TOO_LONG = 1920;
export const TOO_HEAVY = 1_000_000;

/** Longest side in pixels. The ids name the interface texts. */
export const PRESETS = [
  { id: "full", pixels: 1920 },
  { id: "page", pixels: 1280 },
  { id: "half", pixels: 800 },
  { id: "thumb", pixels: 400 },
] as const;

export interface BigImage {
  file: File;
  width: number;
  height: number;
}

const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** The type to encode to, or null for files that are left alone (SVG, GIF, anything not an image). */
function typeOf(file: File): string | null {
  return TYPES[file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase()] ?? null;
}

async function open(file: File): Promise<ImageBitmap | null> {
  try {
    // from-image applies the rotation a phone stores in the photo's metadata.
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
}

/** Returns the images in a batch that are too big, with their dimensions. */
export async function inspect(files: File[]): Promise<BigImage[]> {
  const big: BigImage[] = [];
  for (const file of files) {
    if (!typeOf(file)) continue;
    const bitmap = await open(file);
    if (!bitmap) continue;
    const { width, height } = bitmap;
    bitmap.close();
    if (Math.max(width, height) > TOO_LONG || file.size > TOO_HEAVY) big.push({ file, width, height });
  }
  return big;
}

/**
 * Scales an image down so its longest side is at most `pixels`. The name and the type stay.
 * A file that is already small enough, or that is not a photo format, comes back unchanged.
 */
export async function shrink(file: File, pixels: number): Promise<File> {
  const type = typeOf(file);
  if (!type) return file;
  const bitmap = await open(file);
  if (!bitmap) return file;
  const scale = pixels / Math.max(bitmap.width, bitmap.height);
  if (scale >= 1) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
  return blob ? new File([blob], file.name, { type, lastModified: file.lastModified }) : file;
}
