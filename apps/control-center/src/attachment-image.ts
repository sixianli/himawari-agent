import { IMAGE_DATA_URL, IMAGE_DATA_URL_CHARACTERS } from "./image-data-url.js";

export const IMAGE_FILE_LIMIT_BYTES = 20 * 1024 * 1024;
export const IMAGE_LONG_SIDE = 1568;

const KEPT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const DECODED_TYPES = new Set([...KEPT_TYPES, "image/gif"]);
const KEPT_FILE_BYTES = 1024 * 1024;

export const isImageFile = (file: File) => DECODED_TYPES.has(file.type);

export const dataUrlBytes = (dataUrl: string) => {
  const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
};

export function scaledSize(
  width: number,
  height: number,
  longSide = IMAGE_LONG_SIDE,
): { readonly width: number; readonly height: number } {
  const scale = Math.min(1, longSide / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

const readDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("ATTACHMENT_UNSUPPORTED"));
    reader.readAsDataURL(file);
  });

export async function prepareImage(file: File): Promise<{
  readonly dataUrl: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}> {
  if (!isImageFile(file)) throw new Error("ATTACHMENT_UNSUPPORTED");
  if (file.size > IMAGE_FILE_LIMIT_BYTES) throw new Error("ATTACHMENT_TOO_LARGE");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("ATTACHMENT_UNSUPPORTED");
  });
  try {
    const original = { width: bitmap.width, height: bitmap.height };
    const target = scaledSize(original.width, original.height);
    if (
      KEPT_TYPES.has(file.type) &&
      file.size <= KEPT_FILE_BYTES &&
      target.width === original.width
    ) {
      const dataUrl = await readDataUrl(file);
      if (IMAGE_DATA_URL.test(dataUrl)) return { dataUrl, bytes: file.size, ...original };
    }
    for (const longSide of [IMAGE_LONG_SIDE, 1200, 900]) {
      const size = scaledSize(original.width, original.height, longSide);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("ATTACHMENT_UNSUPPORTED");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, size.width, size.height);
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      if (dataUrl.length <= IMAGE_DATA_URL_CHARACTERS && IMAGE_DATA_URL.test(dataUrl))
        return { dataUrl, bytes: dataUrlBytes(dataUrl), ...size };
    }
    throw new Error("ATTACHMENT_TOO_LARGE");
  } finally {
    bitmap.close();
  }
}

const loaded = new Map<string, Promise<string>>();

export function rememberImage(ref: string, dataUrl: string) {
  loaded.set(ref, Promise.resolve(dataUrl));
}

export function imageOf(ref: string, read: (ref: string) => Promise<string>): Promise<string> {
  const known = loaded.get(ref);
  if (known) return known;
  const pending = read(ref).catch((error: unknown) => {
    loaded.delete(ref);
    throw error;
  });
  loaded.set(ref, pending);
  return pending;
}
