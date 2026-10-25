import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { afterEach, describe, it } from "vitest";
import { validateSystemToolBindings } from "../../scripts/operations/cloud-system-tool-bindings.mjs";

const directories = [];
const names = ["bwrap", "socat", "bash", "rg"];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function identity(filename) {
  const info = lstatSync(filename);
  return {
    device: String(info.dev),
    inode: String(info.ino),
    uid: info.uid,
    gid: info.gid,
    mode: (info.mode & 0o7777).toString(8).padStart(4, "0"),
  };
}

function fixture({ alias = false, chain = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(testTemporaryRoot(), "cloud-tool-binding-")));
  directories.push(root);
  const paths = {};
  const expected = {};
  for (const name of names) {
    const requestedPath = path.join(root, name);
    const target = name === "socat" && alias ? path.join(root, "socat1") : requestedPath;
    writeFileSync(target, `synthetic executable ${name}\n`, { mode: 0o755 });
    const links = [];
    if (name === "socat" && alias) {
      if (chain) {
        const intermediate = path.join(root, "socat-alias");
        symlinkSync("socat1", intermediate);
        symlinkSync("socat-alias", requestedPath);
        links.push(
          { path: requestedPath, target: "socat-alias", identity: identity(requestedPath) },
          { path: intermediate, target: "socat1", identity: identity(intermediate) },
        );
      } else {
        symlinkSync("socat1", requestedPath);
        links.push({ path: requestedPath, target: "socat1", identity: identity(requestedPath) });
      }
    }
    paths[name] = requestedPath;
    expected[name] = {
      requestedPath,
      realpath: target,
      identity: identity(target),
      sha256: createHash("sha256").update(readFileSync(target)).digest("hex"),
      links,
    };
  }
  return { root, paths, expected };
}

function assertRejected(fixture, code = /SYSTEM_TOOL_/u) {
  return assert.rejects(validateSystemToolBindings(fixture.paths, fixture.expected), (error) =>
    code.test(String(error.message)),
  );
}

describe("[R2-L4][BL-20261008-010] cloud system tool bindings", () => {
  it("accepts the approved socat alias and records both its requested path and realpath", async () => {
    const f = fixture({ alias: true });
    const observed = await validateSystemToolBindings(f.paths, f.expected);
    assert.deepEqual(observed.systemToolBindings, f.expected);
    assert.deepEqual(
      observed.systemTools,
      Object.fromEntries(names.map((name) => [f.expected[name].realpath, f.expected[name].sha256])),
    );
  });

  it("accepts regular executable paths without introducing an alias", async () => {
    const f = fixture();
    const observed = await validateSystemToolBindings(f.paths, f.expected);
    assert.deepEqual(observed.systemToolBindings, f.expected);
  });

  it("binds every link in an approved alias chain", async () => {
    const f = fixture({ alias: true, chain: true });
    const observed = await validateSystemToolBindings(f.paths, f.expected);
    assert.deepEqual(observed.systemToolBindings.socat.links, f.expected.socat.links);
  });

  it("rejects a changed alias target even when the new executable has the same bytes", async () => {
    const f = fixture({ alias: true });
    const other = path.join(f.root, "socat2");
    writeFileSync(other, readFileSync(f.expected.socat.realpath), { mode: 0o755 });
    rmSync(f.paths.socat);
    symlinkSync("socat2", f.paths.socat);
    await assertRejected(f);
  });

  it("rejects a replacement executable with identical contents and permissions", async () => {
    const f = fixture({ alias: true });
    const replacement = path.join(f.root, "socat-replacement");
    writeFileSync(replacement, readFileSync(f.expected.socat.realpath), { mode: 0o755 });
    renameSync(replacement, f.expected.socat.realpath);
    await assertRejected(f);
  });

  it("rejects changed executable bytes even when the inode remains the same", async () => {
    const f = fixture();
    const originalInode = lstatSync(f.paths.socat).ino;
    writeFileSync(f.paths.socat, "changed executable bytes\n");
    assert.equal(lstatSync(f.paths.socat).ino, originalInode);
    await assertRejected(f);
  });

  it("rejects a changed intermediate link that still resolves to the approved executable", async () => {
    const f = fixture({ alias: true, chain: true });
    const intermediate = path.join(f.root, "socat-alias");
    rmSync(intermediate);
    symlinkSync("./socat1", intermediate);
    assert.equal(realpathSync(f.paths.socat), f.expected.socat.realpath);
    await assertRejected(f);
  });

  it("rejects an alias replacement whose target text stays the same", async () => {
    const f = fixture({ alias: true });
    const replacement = path.join(f.root, "replacement-alias");
    symlinkSync("socat1", replacement);
    renameSync(replacement, f.paths.socat);
    await assertRejected(f);
  });

  it("rejects a dangling alias", async () => {
    const f = fixture({ alias: true });
    rmSync(f.expected.socat.realpath);
    await assertRejected(f, /SYSTEM_TOOL_|ENOENT/u);
  });

  it.each([0o777, 0o644])(
    "rejects unsafe executable mode %o even if approved input records it",
    async (mode) => {
      const f = fixture();
      chmodSync(f.paths.socat, mode);
      f.expected.socat.identity = identity(f.paths.socat);
      await assertRejected(f);
    },
  );

  it("rejects a directory in place of a system executable", async () => {
    const f = fixture();
    rmSync(f.paths.socat);
    mkdirSync(f.paths.socat);
    f.expected.socat.identity = identity(f.paths.socat);
    await assertRejected(f, /SYSTEM_TOOL_|EISDIR/u);
  });

  it.each(["uid", "gid"])("rejects a changed executable %s identity", async (field) => {
    const f = fixture();
    f.expected.socat.identity[field] += 1;
    await assertRejected(f);
  });

  it("rejects an unapproved link owner identity", async () => {
    const f = fixture({ alias: true });
    f.expected.socat.links[0].identity.uid += 1;
    await assertRejected(f);
  });

  it("rejects missing, extra, and inconsistent approved tool identities", async () => {
    for (const change of [
      (f) => delete f.expected.socat,
      (f) => {
        f.expected.extra = f.expected.socat;
      },
      (f) => {
        f.expected.socat.requestedPath = f.paths.bash;
      },
      (f) => {
        f.paths.socat = "socat";
      },
    ]) {
      const f = fixture();
      change(f);
      await assertRejected(f);
    }
  });

  it("does not execute inspected tools", async () => {
    const f = fixture();
    const marker = path.join(f.root, "executed");
    writeFileSync(f.paths.socat, `#!/bin/sh\nprintf execution > '${marker}'\n`);
    f.expected.socat.sha256 = createHash("sha256")
      .update(readFileSync(f.paths.socat))
      .digest("hex");
    await validateSystemToolBindings(f.paths, f.expected);
    assert.throws(() => lstatSync(marker), { code: "ENOENT" });
  });
});
