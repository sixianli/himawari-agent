import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostBoundBrowserSessionStore, IsolatedWebDownloadStore } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("Web host boundary", () => {
  it("encrypts host-bound browser material and consumes each handle once", async () => {
    const root = await temporaryRoot("himawari-web-session-");
    const store = new HostBoundBrowserSessionStore({
      root,
      hostId: "host-mac",
      keys: {
        kind: "memory-development",
        productionSuitable: false,
        resolve: async () => new Uint8Array(32).fill(7),
      },
      keyRef: "web-session-kek",
      keyVersion: "v1",
    });
    await store.initialize();
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ cookies: [{ name: "session", value: "cookie-secret-value" }] }),
    );
    await store.seal("session-01", plaintext);
    const file = (await readdir(root))[0];
    expect(file).toBeDefined();
    expect(await readFile(path.join(root, file ?? ""), "utf8")).not.toContain(
      "cookie-secret-value",
    );
    const handle = store.issueHandle({
      sessionId: "session-01",
      now: "2026-08-28T20:00:00.000Z",
      expiresAt: "2026-08-28T20:01:00.000Z",
    });
    expect(
      new TextDecoder().decode(await store.consumeHandle(handle.ref, "2026-08-28T20:00:30.000Z")),
    ).toContain("cookie-secret-value");
    await expect(store.consumeHandle(handle.ref, "2026-08-28T20:00:31.000Z")).rejects.toThrow(
      "WEB_SESSION_HANDLE_UNAVAILABLE",
    );
  });

  it("isolates downloads, detects executables and removes expired bytes", async () => {
    const root = await temporaryRoot("himawari-web-download-");
    const store = new IsolatedWebDownloadStore({ root, maximumBytes: 1024 });
    await store.initialize();
    const record = await store.put({
      sourceUrl: "https://public.example/file",
      declaredMimeType: "application/octet-stream",
      bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x01]),
      dataClassification: "public",
      createdAt: "2026-08-28T20:00:00.000Z",
      expiresAt: "2026-08-28T20:01:00.000Z",
    });
    expect(record).toMatchObject({ sniffedMimeType: "application/x-elf", executable: true });
    expect(await store.read(record)).toEqual(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x01]));
    expect(await store.deleteExpired([record], "2026-08-28T20:02:00.000Z")).toBe(1);
    await expect(store.read(record)).rejects.toThrow();
  });
});
