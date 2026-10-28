import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

export interface ProtectedRuntimeAuditRequest {
  readonly root: string;
  readonly ownerUid: number;
}

function auditTree({ root, ownerUid }: ProtectedRuntimeAuditRequest): { protected: true } {
  const visit = (filename: string) => {
    const info = lstatSync(filename);
    if (info.uid !== ownerUid || info.mode & 0o022 || (!info.isFile() && !info.isDirectory()))
      throw new Error("SANDBOX_RUNTIME_PROTECTION_INVALID");
    if (info.isDirectory())
      for (const entry of readdirSync(filename)) visit(path.join(filename, entry));
  };
  visit(root);
  return { protected: true };
}

if (parentPort) parentPort.postMessage(auditTree(workerData as ProtectedRuntimeAuditRequest));
