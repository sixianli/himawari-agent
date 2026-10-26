import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, readlink, realpath, rm, rmdir, symlink } from "node:fs/promises";
import path from "node:path";
import { validateScratchRoot } from "./scratch-root.mjs";

const value = process.argv[2];
assert.equal(await validateScratchRoot(value), value);
const results = [{ name: "valid-owned-0700", passed: true }];
async function rejected(name, candidate, expected) {
  await assert.rejects(validateScratchRoot(candidate), expected);
  results.push({ name, passed: true });
}
await rejected("missing-value", undefined, /SCRATCH_ROOT_NAME_UNSAFE/);
await rejected("different-prefix", "/tmp/xABCD", /SCRATCH_ROOT_NAME_UNSAFE/);
await rejected("lexical-alias", value + "/../" + path.basename(value), /SCRATCH_ROOT_NAME_UNSAFE/);
const link = execFileSync("/usr/bin/mktemp", ["-d", "/tmp/hXXXX"], { encoding: "utf8" }).trim();
assert.match(link, /^\/tmp\/h[A-Za-z0-9]{4}$/);
await rmdir(link);
await symlink(value, link);
try {
  await rejected("symbolic-link", link, /SCRATCH_ROOT_TYPE_UNSAFE/);
} finally {
  assert.equal(await readlink(link), value);
  await rm(link);
}
await chmod(value, 0o755);
try {
  await rejected("world-readable", value, /SCRATCH_ROOT_MODE_UNSAFE/);
} finally {
  await chmod(value, 0o700);
}
await chmod(value, 0o770);
try {
  await rejected("group-writable", value, /SCRATCH_ROOT_MODE_UNSAFE/);
} finally {
  await chmod(value, 0o700);
}
const originalTemp = process.env.TMPDIR;
process.env.TMPDIR = "/tmp";
try {
  await rejected("environment-mismatch", value, /SCRATCH_ROOT_ENVIRONMENT_MISMATCH/);
} finally {
  process.env.TMPDIR = originalTemp;
}
assert.equal(await realpath(value), value);
assert.equal(await validateScratchRoot(value), value);
process.stdout.write(JSON.stringify({ passed: results.length, results, productionQualificationIssued: false }) + "\n");
