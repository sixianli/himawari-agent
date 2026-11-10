import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_EXPORT_ERROR_CODES, DataExportError, type PortableFiles } from "./types.js";
import { assertSafePath } from "./verify.js";

const MAXIMUM_FILE_BYTES = 512 * 1024 * 1024;
const MAXIMUM_FILES = 4096;

export async function writePortableDirectory(
  directory: string,
  files: PortableFiles,
): Promise<void> {
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await readdir(root)).length !== 0)
    throw new DataExportError(DATA_EXPORT_ERROR_CODES.TARGET_NOT_EMPTY, "输出目录必须为空");
  for (const [relative, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    assertSafePath(relative);
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
  }
}

export async function readPortableDirectory(directory: string): Promise<PortableFiles> {
  const root = path.resolve(directory);
  const files: PortableFiles = new Map();
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current)) {
      const full = path.join(current, entry);
      const stat = await lstat(full);
      const relative = path.relative(root, full).split(path.sep).join("/");
      assertSafePath(relative);
      if (stat.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!stat.isFile() || stat.size > MAXIMUM_FILE_BYTES || files.size >= MAXIMUM_FILES)
        throw new DataExportError(DATA_EXPORT_ERROR_CODES.PATH_UNSAFE, relative);
      files.set(relative, new Uint8Array(await readFile(full)));
    }
  };
  await walk(root);
  return files;
}
