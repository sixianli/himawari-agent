import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { prepareJobPolicy } from "../src/job-policy.js";

let root: string;
let input: Parameters<typeof prepareJobPolicy>[0] & { readonly workspace: string };
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "srt-job-policy-")));
  await Promise.all(
    ["workspace", "private"].map((name) => mkdir(path.join(root, name), { mode: 0o700 })),
  );
  input = {
    workspace: path.join(root, "workspace"),
    privateRoot: path.join(root, "private"),
    jobId: "job",
    writable: false,
    readOnlyToolchainPaths: [],
    protectedPaths: [],
    allowedDomains: [],
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it("creates private job scratch and preserves the policy across repeated preparation", async () => {
  const first = await prepareJobPolicy(input);
  const info = await lstat(first.policy.privateDirectory);
  expect(info.mode & 0o777).toBe(0o700);
  expect((await prepareJobPolicy(input)).compiled.policyDigest).toBe(first.compiled.policyDigest);
  expect(JSON.parse(first.compiled.policyJson).filesystem.allowWrite).toEqual([
    first.policy.privateDirectory,
  ]);
});
it.each(["symlink", "permissions", "traversal"])(
  "rejects unsafe scratch: %s without repairing it",
  async (mode) => {
    const job = path.join(input.privateRoot, "job");
    if (mode === "symlink") await symlink(input.workspace, job);
    if (mode === "permissions") {
      await mkdir(job);
      await chmod(job, 0o777);
    }
    await expect(
      prepareJobPolicy({ ...input, jobId: mode === "traversal" ? "../escape" : "job" }),
    ).rejects.toThrow("SANDBOX_PRIVATE_DIRECTORY_INVALID");
    if (mode === "permissions") expect((await lstat(job)).mode & 0o777).toBe(0o777);
    if (mode === "symlink") expect((await lstat(job)).isSymbolicLink()).toBe(true);
  },
);
it("freezes scope before asynchronous directory preparation", async () => {
  const domains = ["example.com:443"];
  const pending = prepareJobPolicy({ ...input, allowedDomains: domains });
  domains.push("other.example");
  expect(JSON.parse((await pending).compiled.policyJson).network.allowedDomains).toEqual([
    "example.com:443",
  ]);
});

it("uses an owned private directory as the network-only working directory", async () => {
  const prepared = await prepareJobPolicy({
    ...input,
    workspace: null,
    allowedDomains: ["example.test:443"],
  });
  expect((await lstat(prepared.policy.privateDirectory)).mode & 0o777).toBe(0o700);
  expect(prepared.compiled.cwd).toBe(prepared.policy.privateDirectory);
  const policy = JSON.parse(prepared.compiled.policyJson);
  expect(policy.filesystem.allowRead).toEqual([prepared.policy.privateDirectory]);
  expect(policy.filesystem.allowWrite).toEqual([prepared.policy.privateDirectory]);
  expect(policy.network.allowedDomains).toEqual(["example.test:443"]);
});
