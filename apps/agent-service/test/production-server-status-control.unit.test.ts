import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProductionServerStatusControl,
  readServerDisk,
  readServerRelease,
  releaseDirectoryOf,
} from "../src/production-server-status-control.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("server status", () => {
  it("reads the running commit from the release directory the service runs from", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-release-"));
    roots.push(root);
    const release = path.join(root, "2026-11-26-25bf704");
    await mkdir(path.join(release, "apps", "agent-service"), { recursive: true });
    const file = path.join(release, "apps", "agent-service", "service-main.js");
    expect(releaseDirectoryOf(file)).toEqual({ directory: release, commit: "25bf704" });
    const read = await readServerRelease(file);
    expect(read?.commit).toBe("25bf704");
    if (read?.installedAt) expect(Date.parse(read.installedAt)).not.toBeNaN();
  });

  it("shows no version when the service does not run from a release directory", async () => {
    expect(releaseDirectoryOf("/home/user/himawari-agent/apps/agent-service/src/x.ts")).toBeNull();
    expect(releaseDirectoryOf("/opt/himawari/releases/2026-11-26-NOTHEX/x.js")).toBeNull();
    expect(await readServerRelease("/home/user/himawari-agent/x.ts")).toBeNull();
  });

  it("reports the space left on the disk that holds the data, and nothing for a missing folder", async () => {
    const disk = await readServerDisk(tmpdir());
    expect(disk?.totalBytes).toBeGreaterThan(0);
    expect(disk?.availableBytes).toBeLessThanOrEqual(disk?.totalBytes ?? 0);
    expect(await readServerDisk(path.join(tmpdir(), "himawari-missing-folder-xyz"))).toBeNull();
  });

  it("still answers when reading the version or the disk fails", async () => {
    const control = new ProductionServerStatusControl({
      configuration: { ownerId: "owner" as never, agentId: "agent" as never },
      health: {
        authenticatedSnapshot: () => ({
          live: true,
          ready: true,
          status: "healthy",
          dependencies: [{ name: "worker", required: true, status: "healthy", reasonCode: null }],
        }),
      },
      clock: { now: () => "2026-11-26T08:00:00.000Z" as never },
      release: () => Promise.reject(new Error("boom")),
      disk: () => Promise.reject(new Error("boom")),
    });
    const snapshot = await control.query({
      kind: "query",
      type: "server.status.read",
      payload: {},
    } as never);
    expect(snapshot.payload).toMatchObject({ release: null, disk: null, ready: true });
  });
});
