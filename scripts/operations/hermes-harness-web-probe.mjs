import assert from "node:assert/strict";
import { readFile, realpath, lstat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
const root = "/data/hermes/himawari/releases/2026-09-11-control-center/share/control-center";
const files = {
  "index.html": "207a5f17812b13459dafde85e818d56a8558d6c98b866aade1f6fbf15665055a",
  "assets/ja-CYkHIGdT.js": "aef85dc5ccad117f59f2ee9e49c13f56904c2c11863ebae70d30e83a00315c8a",
  "assets/index-BQ7wuh-9.js": "0333ebae59b5d0001b007d134fe3a48f2b0e44aabba77e2aeb553246c15e1817",
  "assets/index-B32F2PDK.css": "e5f55053f721233e9110ae1dcb1b80bf1740492bd95d39973ce8218f0caaec1d",
  "assets/logo-symbol-light-DDULTiXD.png":
    "62ae5ef7b6cf6fb98cea007bfaba986d9b62f2745b7a579c26977b4ecc11015b",
  "assets/en-BGDC4yOB.js": "c15a0296a871960ae8f61498c9082559ea298424b197bee6f8e9a9ee31ab7bb5",
};
assert.equal(hostname(), "hermes-home");
assert.equal(process.getuid(), 998);
assert.equal(process.argv.length, 2);
assert.equal(await realpath(root), root);
async function walk(directory, relative = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = relative + entry.name,
      full = directory + "/" + entry.name;
    assert(!entry.isSymbolicLink());
    if (entry.isDirectory()) result.push(...(await walk(full, name + "/")));
    else {
      assert(entry.isFile());
      result.push(name);
    }
  }
  return result.sort();
}
assert.deepEqual(await walk(root), Object.keys(files).sort());
for (const [name, digest] of Object.entries(files)) {
  const p = root + "/" + name,
    info = await lstat(p);
  assert.equal(await realpath(p), p);
  assert(info.isFile() && info.uid === 0 && info.nlink === 1 && !(info.mode & 0o022));
  assert.equal(
    createHash("sha256")
      .update(await readFile(p))
      .digest("hex"),
    digest,
  );
}
const html = await readFile(root + "/index.html", "utf8");
for (const match of html.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)) assert(files[match[1].slice(1)]);
console.log(
  JSON.stringify({
    passed: true,
    runtimeUid: process.getuid(),
    staticFiles: Object.keys(files).length,
  }),
);
