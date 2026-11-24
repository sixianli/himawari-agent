import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const head = "__PKT_COMMIT__";
const fail = (condition, message) => { if (!condition) throw new Error(message); };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  fail(["--source-root", "--modules-root", "--output", "--npm-cli"].includes(key) && value && path.isAbsolute(value) && !args[key], "P5_ARGUMENT_INVALID");
  args[key] = value;
}
fail(Object.keys(args).length === 4 && process.version === "v22.22.3" && process.platform === "linux" && process.arch === "x64", "P5_ENVIRONMENT_INVALID");
const source = realpathSync(args["--source-root"]), modules = realpathSync(args["--modules-root"]), output = path.resolve(args["--output"]);
fail(source === args["--source-root"] && modules === args["--modules-root"] && path.basename(modules) === "node_modules", "P5_SOURCE_PATH_INVALID");
fail(!output.startsWith(source + path.sep) && !output.startsWith(modules + path.sep), "P5_OUTPUT_OVERLAP");
const git = (values) => execFileSync("git", ["-C", source, ...values], { encoding: "utf8" }).trim();
fail(git(["rev-parse", "HEAD"]) === head && git(["status", "--porcelain", "--untracked-files=all"]) === "", "P5_SOURCE_IDENTITY_INVALID");
const lockBytes = readFileSync(path.join(source, "package-lock.json")), lock = JSON.parse(lockBytes);
fail(hash(readFileSync(path.join(path.dirname(modules), "package-lock.json"))) === hash(lockBytes), "P5_INSTALLED_LOCK_DIFFERENT");
mkdirSync(output, { mode: 0o700 });
const npm = realpathSync(args["--npm-cli"]);
fail(npm === args["--npm-cli"] && JSON.parse(readFileSync(path.resolve(path.dirname(npm), "../package.json"))).version === "11.8.0", "P5_NPM_IDENTITY_INVALID");
const npmArgs = [npm, "ls", "--all", "--json", "--offline", "--ignore-scripts", "--cache", path.join(output, "npm-cache")];
let npmOutput;
try {
  npmOutput = execFileSync(process.execPath, npmArgs, { cwd: path.dirname(modules), env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: output, LANG: "C.UTF-8" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
} catch (error) {
  writeFileSync(path.join(output, "npm-ls.json"), error.stdout ?? "", { mode: 0o600, flag: "wx" });
  writeFileSync(path.join(output, "npm-ls.stderr"), error.stderr ?? String(error), { mode: 0o600, flag: "wx" });
  throw error;
}
writeFileSync(path.join(output, "npm-ls.json"), npmOutput, { mode: 0o600, flag: "wx" });
const packages = [];
for (const [relative, item] of Object.entries(lock.packages)) {
  if (!relative.startsWith("node_modules/") && !relative.includes("/node_modules/")) continue;
  const filename = path.join(path.dirname(modules), relative);
  let info;
  try { info = lstatSync(filename); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!info) { fail(item.optional === true, `P5_REQUIRED_LOCK_PACKAGE_MISSING:${relative}`); packages.push({ path: relative, optional: true, installed: false }); continue; }
  if (item.link === true) {
    fail(info.isSymbolicLink() && !path.isAbsolute(readlinkSync(filename)) && path.resolve(path.dirname(filename), readlinkSync(filename)) === path.resolve(path.dirname(modules), item.resolved), `P5_WORKSPACE_LINK_MISMATCH:${relative}`);
    packages.push({ path: relative, link: true, resolved: item.resolved, installed: true });
  } else {
    const metadata = JSON.parse(readFileSync(path.join(filename, "package.json")));
    fail(info.isDirectory() && metadata.version === item.version, `P5_DEPENDENCY_LOCK_MISMATCH:${relative}`);
    packages.push({ path: relative, name: metadata.name, version: metadata.version, installed: true });
  }
}
const dependencyRoots = [...new Set(packages.map((item) => { const index = item.path.indexOf("node_modules/"); return item.path.slice(0, index) + "node_modules"; }))].sort();
fail(dependencyRoots.includes("node_modules") && dependencyRoots.every((relative) => !path.isAbsolute(relative) && !relative.split("/").includes("..")), "P5_DEPENDENCY_ROOT_INVALID");
const payload = path.join(output, "payload");
mkdirSync(payload, { mode: 0o755 });
const entries = [];
function copyTree(filename, relative) {
  const before = lstatSync(filename), target = path.join(payload, relative);
  if (before.isDirectory()) {
    mkdirSync(target, { mode: 0o755 });
    entries.push({ path: relative, type: "directory", mode: 0o755 });
    for (const name of readdirSync(filename).sort()) copyTree(path.join(filename, name), `${relative}/${name}`);
  } else if (before.isSymbolicLink()) {
    const link = readlinkSync(filename), resolved = path.resolve(path.dirname(filename), link);
    fail(!path.isAbsolute(link) && (dependencyRoots.some((root) => resolved.startsWith(path.resolve(path.dirname(modules), root) + path.sep)) || packages.some((item) => item.link && path.resolve(path.dirname(modules), item.path) === filename && resolved === path.resolve(path.dirname(modules), item.resolved))), `P5_MODULE_LINK_UNSAFE:${relative}`);
    symlinkSync(link, target);
    entries.push({ path: relative, type: "symlink", link, mode: 0o777 });
  } else {
    fail(before.isFile(), `P5_MODULE_SPECIAL_FILE:${relative}`);
    const bytes = readFileSync(filename), sha256 = hash(bytes), mode = before.mode & 0o111 ? 0o755 : 0o644;
    copyFileSync(filename, target);
    chmodSync(target, mode);
    entries.push({ path: relative, type: "file", sha256, bytes: bytes.length, mode });
    fail(hash(readFileSync(target)) === sha256, `P5_MODULE_COPY_FAILED:${relative}`);
  }
  const after = lstatSync(filename);
  fail(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `P5_MODULE_CHANGED:${relative}`);
}
const TOOL_CACHE_ENTRIES = new Set([".vite", ".vite-temp", ".cache"]);
const NPM_ENTRIES = new Set([".bin", ".package-lock.json"]);
for (const relative of dependencyRoots) {
  const target = path.join(payload, relative), root = path.join(path.dirname(modules), relative);
  const locked = new Set(packages.filter((item) => item.path.startsWith(`${relative}/`) && !item.path.slice(relative.length + 1).includes("/node_modules/")).map((item) => item.path.slice(relative.length + 1).split("/")[0]));
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  fail(lstatSync(root).isDirectory(), `P5_DEPENDENCY_ROOT_INVALID:${relative}`);
  mkdirSync(target, { mode: 0o755 });
  entries.push({ path: relative, type: "directory", mode: 0o755 });
  for (const name of readdirSync(root).sort()) {
    if (TOOL_CACHE_ENTRIES.has(name)) continue;
    fail(locked.has(name) || NPM_ENTRIES.has(name), `P5_MODULE_UNEXPECTED_ENTRY:${relative}/${name}`);
    copyTree(path.join(root, name), `${relative}/${name}`);
  }
}
entries.sort((a, b) => a.path.localeCompare(b.path));
const list = path.join(output, "files.list");
writeFileSync(list, entries.map((item) => item.path).join("\0") + "\0", { mode: 0o600, flag: "wx" });
const archive = path.join(output, "node-modules.tar.gz");
execFileSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--hard-dereference", "--no-recursion", "-czf", archive, "-C", payload, "--null", "-T", list], { stdio: "pipe" });
const record = { schemaVersion: 2, scope: "whole-locked-node-modules", sourceHead: head, node: process.version, platform: `${process.platform}-${process.arch}`, packageLockSha256: hash(lockBytes), lockCheck: { method: "npm ls --all plus lock package identity readback", executable: process.execPath, args: npmArgs, exitCode: 0, outputSha256: hash(npmOutput) }, dependencyRoots, packages, entries, archive: { name: path.basename(archive), bytes: statSync(archive).size, sha256: hash(readFileSync(archive)) } };
writeFileSync(path.join(output, "node-modules.json"), JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
process.stdout.write(JSON.stringify({ output, scope: record.scope, packages: packages.length, entries: entries.length, lockCheckExitCode: 0, archive: record.archive }) + "\n");
