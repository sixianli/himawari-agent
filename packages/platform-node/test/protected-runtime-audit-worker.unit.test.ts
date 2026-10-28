import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { auditProtectedRuntime } from "../src/capabilities/protected-runtime.js";

let root: string;
const owner = process.getuid?.() ?? 0;
const put = (name: string) => {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  writeFileSync(file, "fixture", { mode: 0o644 });
  return file;
};
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "protected-runtime-audit-")));
  chmodSync(root, 0o755);
  put("bin/helper.js");
  put("node_modules/package/deep/index.js");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("accepts an installation whose every entry is owned by the deployment owner and not writable by others", async () => {
  await expect(auditProtectedRuntime(root, owner)).resolves.toBeUndefined();
});

it.each([
  ["a nested file writable by its group", () => chmodSync(put("a/b/c.js"), 0o664)],
  ["a directory writable by others", () => chmodSync(path.join(root, "node_modules"), 0o757)],
  ["the installation root writable by its group", () => chmodSync(root, 0o775)],
  [
    "a symlink, even to a protected file",
    () => symlinkSync(path.join(root, "bin/helper.js"), path.join(root, "bin/link.js")),
  ],
])("rejects %s", async (_label, change) => {
  change();
  await expect(auditProtectedRuntime(root, owner)).rejects.toThrow(
    "SANDBOX_RUNTIME_PROTECTION_INVALID",
  );
});

it("rejects entries owned by anyone other than the required owner", async () => {
  await expect(auditProtectedRuntime(root, owner + 1)).rejects.toThrow(
    "SANDBOX_RUNTIME_PROTECTION_INVALID",
  );
});

it("fails instead of passing when the installation is missing", async () => {
  await expect(auditProtectedRuntime(path.join(root, "missing"), owner)).rejects.toThrow("ENOENT");
});
