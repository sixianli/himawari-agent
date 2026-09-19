import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HostDirectoryGrant } from "@himawari-agent/application";
import { sandboxScopeSchema } from "@himawari-agent/execution-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConstrainedHostFileSystem,
  createPiFilePublicationJournal,
  createSandboxedCodingOperations,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(initial?: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-publication-")));
  roots.push(root);
  const workspace = path.join(root, "workspace"),
    privateDirectory = path.join(root, "job");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(privateDirectory, { mode: 0o700 });
  const target = path.join(workspace, "file.txt");
  if (initial !== undefined) await writeFile(target, initial);
  const platform = new ConstrainedHostFileSystem(),
    identity = await platform.inspectRoot(workspace);
  const grant: HostDirectoryGrant = {
    id: "directory",
    revision: 1,
    hostId: "host",
    canonicalRootId: `${identity.device}:${identity.inode}`,
    displayPath: workspace,
    operations: ["read", "create", "update"],
    dataClassification: "private",
    disclosure: "worker",
    pathPolicy: "same_filesystem_no_links",
    mountPolicy: "fixed_device",
    authorizationRef: "authority",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
  };
  const before = await platform.inspect(grant, "file.txt");
  const scope = sandboxScopeSchema.parse({
    schemaVersion: "sandbox-scope.v1",
    ownerId: "owner",
    agentId: "agent",
    threadId: "thread",
    runId: "run",
    toolCallId: "call",
    parentToolCallId: null,
    parentRequestId: "request",
    hostId: "host",
    handleRef: "handle",
    inputRef: "input",
    operation: "write",
    authorizationRef: "authority",
    modelRef: "model",
    profileRef: "authorized-project.v1",
    directoryGrant: {
      ref: grant.id,
      revision: grant.revision,
      canonicalRootId: grant.canonicalRootId,
      authorizationRef: grant.authorizationRef,
      operations: grant.operations,
    },
    networkAuthorizationRef: null,
    expiresAt: grant.expiresAt,
    fileTarget: {
      schemaVersion: "sandbox-file-target.v1",
      relativePath: "file.txt",
      lineage: [{ device: identity.device, inode: identity.inode }],
      before: before
        ? {
            device: before.device,
            inode: before.inode,
            contentDigest: createHash("sha256")
              .update(initial as string)
              .digest("hex"),
          }
        : null,
    },
  });
  const context = {
    workspace,
    privateDirectory,
    scope,
    parametersJson: JSON.stringify({ path: "file.txt", content: "candidate" }),
  };
  const journal = createPiFilePublicationJournal(context);
  const expectedTarget = scope.fileTarget;
  if (!expectedTarget) throw new Error("missing fixture file target");
  const operations = async (
    hooks: {
      onPreparedWrite?: typeof journal.prepared;
      onVerifiedWrite?: typeof journal.verified;
    } = {},
  ) =>
    createSandboxedCodingOperations({
      grant,
      targetPath: target,
      expectedTarget,
      shell: "/bin/bash",
      privateDirectory,
      binaryDirectory: "/usr/bin",
      maxOutputBytes: 4096,
      onPreparedWrite: journal.prepared,
      onVerifiedWrite: journal.verified,
      ...hooks,
    });
  return { root, target, grant, context, journal, operations };
}
describe("fixed Pi file publication records", () => {
  it("binds parents created during publication before recovering an interrupted receipt", async () => {
    const f = await setup();
    const scope = sandboxScopeSchema.parse({
      ...f.context.scope,
      fileTarget: {
        ...f.context.scope.fileTarget,
        relativePath: "new/file.txt",
        missingParents: 1,
      },
    });
    const context = {
      ...f.context,
      scope,
      parametersJson: JSON.stringify({ path: "new/file.txt", content: "candidate" }),
    };
    const journal = createPiFilePublicationJournal(context);
    const bytes = Buffer.from("candidate");
    await new ConstrainedHostFileSystem().createExclusive(f.grant, "new/file.txt", bytes, {
      beforePublish: (publication) =>
        journal.prepared({
          publication,
          relativePath: "new/file.txt",
          byteLength: bytes.length,
          contentDigest: createHash("sha256").update(bytes).digest("hex"),
        }),
    });
    await rename(path.join(context.workspace, "new"), path.join(context.workspace, "old"));
    await mkdir(path.join(context.workspace, "new"));
    await rename(
      path.join(context.workspace, "old/file.txt"),
      path.join(context.workspace, "new/file.txt"),
    );
    await expect(createPiFilePublicationJournal(context).recover(f.grant)).rejects.toThrow(
      "PI_PUBLICATION_RECORD_INVALID",
    );
    expect(await readFile(path.join(context.workspace, "new/file.txt"), "utf8")).toBe("candidate");
  });
  it.each([undefined, "original"])(
    "retains successful publication across a new reader (%s)",
    async (initial) => {
      const f = await setup(initial);
      await (await f.operations()).writeFile(f.target, "candidate");
      const proof = await createPiFilePublicationJournal(f.context).recover({
        ...f.grant,
        revokedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:00:00.000Z",
      });
      expect(proof).toEqual({
        path: f.target,
        byteLength: 9,
        contentDigest: createHash("sha256").update("candidate").digest("hex"),
      });
      const stored = await readFile(
        path.join(f.context.privateDirectory, "pi-file-prepared.v1.json"),
        "utf8",
      );
      expect(stored).not.toContain('"candidate"');
      expect(await readFile(f.target, "utf8")).toBe("candidate");
    },
  );
  it("recovers an actual publication interrupted before the verified record", async () => {
    const f = await setup("original");
    const port = await f.operations({
      async onVerifiedWrite() {
        throw new Error("INTERRUPTED");
      },
    });
    await expect(port.writeFile(f.target, "candidate")).rejects.toThrow("INTERRUPTED");
    expect(await createPiFilePublicationJournal(f.context).recover(f.grant)).toMatchObject({
      byteLength: 9,
    });
    expect(await readFile(f.target, "utf8")).toBe("candidate");
    await expect(
      readFile(path.join(f.context.privateDirectory, "pi-file-verified.v1.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("never publishes a staged candidate during recovery", async () => {
    const f = await setup("original");
    const port = await f.operations({
      async onPreparedWrite(proof) {
        await f.journal.prepared(proof);
        throw new Error("INTERRUPTED");
      },
    });
    await expect(port.writeFile(f.target, "candidate")).rejects.toThrow("INTERRUPTED");
    await expect(createPiFilePublicationJournal(f.context).recover(f.grant)).rejects.toThrow(
      "HOST_FILE_PUBLICATION_UNVERIFIED",
    );
    expect(await readFile(f.target, "utf8")).toBe("original");
  });
  it("does not infer success from equal bytes at a different inode", async () => {
    const f = await setup("original");
    await expect(
      (
        await f.operations({
          async onVerifiedWrite() {
            throw new Error("INTERRUPTED");
          },
        })
      ).writeFile(f.target, "candidate"),
    ).rejects.toThrow();
    await rename(f.target, path.join(f.context.workspace, "saved.txt"));
    await writeFile(f.target, "candidate");
    await expect(createPiFilePublicationJournal(f.context).recover(f.grant)).rejects.toThrow(
      "HOST_FILE_PUBLICATION_UNVERIFIED",
    );
    expect(await readFile(f.target, "utf8")).toBe("candidate");
  });
  it("preserves later edits while returning an already witnessed historical effect", async () => {
    const f = await setup("original");
    await (await f.operations()).writeFile(f.target, "candidate");
    await writeFile(f.target, "later user edit");
    expect(await createPiFilePublicationJournal(f.context).recover(f.grant)).toMatchObject({
      byteLength: 9,
    });
    expect(await readFile(f.target, "utf8")).toBe("later user edit");
  });
  it.each(["scope", "input", "symlink", "truncated"])(
    "rejects %s record mismatch",
    async (change) => {
      const f = await setup("original");
      await (await f.operations()).writeFile(f.target, "candidate");
      const context = structuredClone(f.context);
      if (change === "scope") context.scope = { ...context.scope, toolCallId: "other" };
      if (change === "input")
        context.parametersJson = JSON.stringify({ path: "file.txt", content: "different" });
      const filename = path.join(context.privateDirectory, "pi-file-prepared.v1.json");
      if (change === "symlink") {
        await rename(filename, `${filename}.saved`);
        await symlink(`${filename}.saved`, filename);
      }
      if (change === "truncated") await writeFile(filename, "{");
      await expect(createPiFilePublicationJournal(context).recover(f.grant)).rejects.toThrow();
      expect(await readFile(f.target, "utf8")).toBe("candidate");
    },
  );
});

describe("prepared candidates and short publication", () => {
  it("keeps parallel candidates, commits one baseline and preserves the losing candidate", async () => {
    const f = await setup("before");
    const platform = new ConstrainedHostFileSystem();
    const [first, second] = await Promise.all([
      platform.stagePublication(f.grant, Buffer.from("first")),
      platform.stagePublication(f.grant, Buffer.from("second")),
    ]);
    const before = await platform.inspect(f.grant, "file.txt");
    if (!before) throw new Error("missing baseline");
    expect(await readFile(f.target, "utf8")).toBe("before");
    await platform.publishPrepared(f.grant, "file.txt", first, before, Buffer.from("before"));
    await expect(
      platform.publishPrepared(f.grant, "file.txt", second, before, Buffer.from("before")),
    ).rejects.toThrow("HOST_FILE_IDENTITY_CHANGED");
    expect(await readFile(f.target, "utf8")).toBe("first");
    expect(Buffer.from(await platform.readPublication(f.grant, second)).toString()).toBe("second");
  });
  it("does not create target parents during preparation and rejects a replaced candidate", async () => {
    const f = await setup();
    const platform = new ConstrainedHostFileSystem();
    const candidate = await platform.stagePublication(f.grant, Buffer.from("candidate"));
    await expect(readFile(path.join(f.grant.displayPath, "new/file.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await rename(candidate.identity.canonicalPath, `${candidate.identity.canonicalPath}.saved`);
    await writeFile(candidate.identity.canonicalPath, "candidate");
    await expect(
      platform.publishPrepared(f.grant, "new/file.txt", candidate, null, new Uint8Array()),
    ).rejects.toThrow("HOST_FILE_PUBLICATION_UNVERIFIED");
    await expect(readFile(path.join(f.grant.displayPath, "new/file.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("rechecks authority after a prepared candidate waits and retains the original file", async () => {
    const f = await setup("before");
    const platform = new ConstrainedHostFileSystem();
    const candidate = await platform.stagePublication(f.grant, Buffer.from("candidate"));
    const baseline = await platform.inspect(f.grant, "file.txt");
    if (!baseline) throw new Error("missing baseline");
    await expect(
      platform.publishPrepared(f.grant, "file.txt", candidate, baseline, Buffer.from("before"), {
        beforePublish: async () => {},
        assertCurrentAuthority: async () => {
          throw new Error("REVOKED");
        },
      }),
    ).rejects.toThrow("REVOKED");
    expect(await readFile(f.target, "utf8")).toBe("before");
    expect(Buffer.from(await platform.readPublication(f.grant, candidate)).toString()).toBe(
      "candidate",
    );
  });
});
