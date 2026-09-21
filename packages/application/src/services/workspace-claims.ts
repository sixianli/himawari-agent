import type { SandboxWorkspaceClaim } from "../ports/sandbox-execution-journal.js";

export function workspaceClaimsOverlap(
  a: SandboxWorkspaceClaim,
  b: SandboxWorkspaceClaim,
): boolean {
  if (a.hostId !== b.hostId) return false;
  const equal = (
    left: SandboxWorkspaceClaim["lineage"][number] | null | undefined,
    right: SandboxWorkspaceClaim["lineage"][number] | null | undefined,
  ) => left != null && right != null && left.device === right.device && left.inode === right.inode;
  const left = a.lineage.at(-1);
  const right = b.lineage.at(-1);
  if (a.file && b.file)
    return (
      (equal(left, right) && a.file.name === b.file.name) || equal(a.file.identity, b.file.identity)
    );
  if (a.file) return a.lineage.some((item) => equal(item, right));
  if (b.file) return b.lineage.some((item) => equal(item, left));
  return (
    a.lineage.some((item) => equal(item, right)) || b.lineage.some((item) => equal(item, left))
  );
}
export function workspaceClaimsConflict(
  a: SandboxWorkspaceClaim,
  b: SandboxWorkspaceClaim,
  uncertain = false,
): boolean {
  if (!workspaceClaimsOverlap(a, b)) return false;
  if (uncertain) return true;
  if (a.access === "read" && b.access === "read") return false;
  if (a.file && b.file && a.access !== b.access) {
    const writer = a.access === "write" ? a : b;
    if (writer.file?.atomicPublish) return false;
  }
  return true;
}
