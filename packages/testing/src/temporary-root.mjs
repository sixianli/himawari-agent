import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";

export function testTemporaryRoot(environment = process.env) {
  const root = environment.HIMAWARI_TEST_TEMP_ROOT;
  if (root === undefined) return "/tmp";
  if (!path.isAbsolute(root)) throw new Error("HIMAWARI_TEST_TEMP_ROOT must be absolute");
  let canonical;
  try {
    canonical = realpathSync(root);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("HIMAWARI_TEST_TEMP_ROOT does not exist", { cause: error });
    throw new Error("HIMAWARI_TEST_TEMP_ROOT cannot be resolved", { cause: error });
  }
  if (canonical !== root)
    throw new Error("HIMAWARI_TEST_TEMP_ROOT must equal its realpath without symlinks");
  if (!statSync(root).isDirectory()) throw new Error("HIMAWARI_TEST_TEMP_ROOT must be a directory");
  try {
    accessSync(root, constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new Error("HIMAWARI_TEST_TEMP_ROOT must be writable and searchable", { cause: error });
  }
  return root;
}
