import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import path from "node:path";

const names = ["bwrap", "socat", "bash", "rg"];

function fileIdentity(info) {
  return {
    device: String(info.dev),
    inode: String(info.ino),
    uid: Number(info.uid),
    gid: Number(info.gid),
    mode: (Number(info.mode) & 0o7777).toString(8).padStart(4, "0"),
  };
}

function readIdentity(info) {
  return [
    info.dev,
    info.ino,
    info.uid,
    info.gid,
    info.mode,
    info.nlink,
    info.size,
    info.mtimeNs,
    info.ctimeNs,
  ];
}

async function resolveTool(requestedPath) {
  assert(
    typeof requestedPath === "string" &&
      path.isAbsolute(requestedPath) &&
      path.normalize(requestedPath) === requestedPath,
    "SYSTEM_TOOL_PATH_INVALID",
  );
  const pending = requestedPath.split("/").filter(Boolean);
  const links = [];
  let current = "/";
  while (pending.length > 0) {
    const component = pending.shift();
    if (component === ".") continue;
    if (component === "..") {
      current = path.dirname(current);
      continue;
    }
    const candidate = path.join(current, component);
    const before = await lstat(candidate, { bigint: true });
    if (before.isSymbolicLink()) {
      assert(links.length < 40, "SYSTEM_TOOL_LINK_CHAIN_INVALID");
      const target = await readlink(candidate);
      const after = await lstat(candidate, { bigint: true });
      assert.deepEqual(readIdentity(after), readIdentity(before), "SYSTEM_TOOL_LINK_CHANGED");
      links.push({ path: candidate, target, identity: fileIdentity(before) });
      if (path.isAbsolute(target)) current = "/";
      pending.unshift(...target.split("/").filter(Boolean));
    } else {
      assert(pending.length === 0 || before.isDirectory(), "SYSTEM_TOOL_PATH_INVALID");
      current = candidate;
    }
  }
  const info = await lstat(current, { bigint: true });
  assert(info.isFile() && !info.isSymbolicLink(), "SYSTEM_TOOL_EXECUTABLE_REQUIRED");
  const mode = Number(info.mode);
  assert((mode & 0o022) === 0 && (mode & 0o111) !== 0, "SYSTEM_TOOL_MODE_UNSAFE");
  assert.equal(await realpath(requestedPath), current, "SYSTEM_TOOL_RESOLUTION_CHANGED");
  return { realpath: current, identity: fileIdentity(info), links, info };
}

async function observeTool(requestedPath) {
  const resolved = await resolveTool(requestedPath);
  const handle = await open(resolved.realpath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let sha256;
  try {
    const opened = await handle.stat({ bigint: true });
    assert.deepEqual(readIdentity(opened), readIdentity(resolved.info), "SYSTEM_TOOL_CHANGED");
    sha256 = createHash("sha256")
      .update(await handle.readFile())
      .digest("hex");
    assert.deepEqual(
      readIdentity(await handle.stat({ bigint: true })),
      readIdentity(opened),
      "SYSTEM_TOOL_CHANGED_DURING_READ",
    );
  } finally {
    await handle.close();
  }
  const after = await resolveTool(requestedPath);
  assert.deepEqual(readIdentity(after.info), readIdentity(resolved.info), "SYSTEM_TOOL_CHANGED");
  assert.deepEqual(after.links, resolved.links, "SYSTEM_TOOL_LINK_CHANGED");
  return {
    requestedPath,
    realpath: resolved.realpath,
    identity: resolved.identity,
    sha256,
    links: resolved.links,
  };
}

export async function collectSystemToolBindings(systemToolPaths) {
  assert.deepEqual(
    Object.keys(systemToolPaths).sort(),
    [...names].sort(),
    "SYSTEM_TOOL_INPUT_INVALID",
  );
  const systemTools = {};
  const systemToolBindings = {};
  for (const name of names) {
    const observed = await observeTool(systemToolPaths[name]);
    systemToolBindings[name] = observed;
    systemTools[observed.realpath] = observed.sha256;
  }
  return { systemTools, systemToolBindings };
}

export async function validateSystemToolBindings(systemToolPaths, systemToolIdentities) {
  assert(
    systemToolIdentities && typeof systemToolIdentities === "object",
    "SYSTEM_TOOL_IDENTITIES_REQUIRED",
  );
  assert.deepEqual(
    Object.keys(systemToolIdentities).sort(),
    [...names].sort(),
    "SYSTEM_TOOL_IDENTITIES_INVALID",
  );
  const observed = await collectSystemToolBindings(systemToolPaths);
  for (const name of names)
    assert.deepEqual(
      observed.systemToolBindings[name],
      systemToolIdentities[name],
      "SYSTEM_TOOL_BINDING_CHANGED:" + name,
    );
  return observed;
}
