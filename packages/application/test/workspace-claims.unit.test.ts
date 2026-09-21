import { describe, expect, it } from "vitest";
import type { SandboxWorkspaceClaim } from "../src/ports/sandbox-execution-journal.js";
import { workspaceClaimsConflict } from "../src/services/workspace-claims.js";

const root = { device: "1", inode: "10" };
const reports = { device: "1", inode: "11" };
const file = (name: string, access: "read" | "write", inode = name): SandboxWorkspaceClaim => ({
  ref: name,
  hostId: "host",
  canonicalRootId: "1:10",
  access,
  lineage: [root, reports],
  file: { name, identity: { device: "1", inode }, atomicPublish: access === "write" },
});
const rename: SandboxWorkspaceClaim = {
  ref: "rename",
  hostId: "host",
  canonicalRootId: "1:10",
  access: "write",
  lineage: [root, reports],
};
describe("operation resource conflicts", () => {
  it("keeps independent files and complete atomic-version reads concurrent", () => {
    expect(workspaceClaimsConflict(file("a", "write"), file("b", "write"))).toBe(false);
    expect(workspaceClaimsConflict(file("a", "read"), file("a", "read"))).toBe(false);
    expect(workspaceClaimsConflict(file("a", "read"), file("a", "write"))).toBe(false);
    expect(workspaceClaimsConflict(file("a", "write"), file("a", "write", "replaced"))).toBe(true);
    expect(
      workspaceClaimsConflict(file("a", "write", "same"), file("alias", "write", "same")),
    ).toBe(true);
  });
  it("directory rename conflicts with descendants but not a sibling directory", () => {
    expect(workspaceClaimsConflict(rename, file("a", "read"))).toBe(true);
    expect(workspaceClaimsConflict(rename, file("b", "write"))).toBe(true);
    expect(
      workspaceClaimsConflict(rename, {
        ...file("a", "write"),
        lineage: [root, { device: "1", inode: "12" }],
      }),
    ).toBe(false);
  });
  it("stable reads exclude in-place writes and uncertain writers", () => {
    const read = file("a", "read");
    const write = file("a", "write");
    if (!write.file) throw new Error("missing file claim");
    expect(
      workspaceClaimsConflict(read, { ...write, file: { ...write.file, atomicPublish: false } }),
    ).toBe(true);
    expect(workspaceClaimsConflict(read, write, true)).toBe(true);
  });
});
