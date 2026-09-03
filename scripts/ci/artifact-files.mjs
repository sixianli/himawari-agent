import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { safeRelativePath, sha256 } from "./contracts.mjs";

export async function digestFile(filename) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest("hex");
}

export async function collectArtifactFiles(root, { normalizeModes = false } = {}) {
  const output = [];
  const visit = async (directory, prefix = "") => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safeRelativePath(name)) throw new Error(`ARTIFACT_UNSAFE_PATH:${name}`);
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`ARTIFACT_LINK_FORBIDDEN:${name}`);
      if (entry.isDirectory()) await visit(filename, name);
      else if (entry.isFile()) {
        const info = await lstat(filename);
        const mode = normalizeModes ? (info.mode & 0o111 ? 0o755 : 0o644) : info.mode & 0o777;
        if (normalizeModes) await chmod(filename, mode);
        output.push({ path: name, sha256: await digestFile(filename), bytes: info.size, mode });
      } else throw new Error(`ARTIFACT_SPECIAL_FILE:${name}`);
    }
  };
  await visit(root);
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

export const contentDigest = (files) => sha256(JSON.stringify(files));
export const jsonFile = async (filename) => JSON.parse(await readFile(filename, "utf8"));
