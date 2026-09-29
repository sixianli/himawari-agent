import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { prepareProductPathTiming } from "../fixtures/product-path-timing.ts";
import { openSandboxJournal, T1 } from "../fixtures/sqlite-capability-invocation-fixture.ts";

const execFile = promisify(execFileCallback);
it("classifies scope failures without retaining arbitrary private messages", async () => {
  const moduleUrl = new URL("../fixtures/product-path-timing-runtime.mjs", import.meta.url).href;
  const { stdout } = await execFile(process.execPath, [
    "--input-type=module",
    "-e",
    `import { failure } from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify([
      "scope expired", "invalid scope window or binding", "SANDBOX_SCOPE_UNAVAILABLE",
      "directory authority changed", "private-token /private/secret.txt"
    ].map(message => failure(new Error(message)))));`,
  ]);
  expect(JSON.parse(stdout)).toEqual(
    [
      "SANDBOX_SCOPE_EXPIRED",
      "SANDBOX_SCOPE_WINDOW_OR_BINDING_INVALID",
      "SANDBOX_SCOPE_UNAVAILABLE",
      "SANDBOX_DIRECTORY_AUTHORITY_CHANGED",
      "UNKNOWN",
    ].map((machineReason) => ({ systemCode: "UNKNOWN", machineReason, validationError: false })),
  );
  expect(stdout).not.toContain("private-token");
  expect(stdout).not.toContain("secret.txt");
});

it.each(["during-parent", "before-parent", "private-parent"] as const)(
  "records the internal scope failure while preserving the public rejection: %s",
  async (window) => {
    const f = await openSandboxJournal();
    const root = await mkdtemp(path.join(tmpdir(), "hma-timing-proof-"));
    try {
      vi.stubEnv("HIMAWARI_TEST_TIMING_DIAGNOSTICS", "1");
      const manifest = path.join(root, "manifest.json");
      const output = path.join(root, "timing.jsonl");
      const runtime = path.resolve("dist/node-runtime");
      await prepareProductPathTiming(runtime, manifest);
      const payload = path.join(root, "fixture.json");
      const { semanticFingerprint: _fingerprint, ...plan } = f.plan;
      await writeFile(
        payload,
        JSON.stringify({
          plan,
          scope: f.scope,
          directoryGrant: {
            ...f.directoryGrant,
            expiresAt: new Date(Date.parse(f.plan.effectiveDeadlineAt) + 60000).toISOString(),
          },
          payload: { ...f.scopePayload, ciphertext: Array.from(f.scopePayload.ciphertext) },
        }),
        { mode: 0o600 },
      );
      const scopeModule = pathToFileURL(
        path.join(
          runtime,
          "node_modules/@himawari-agent/application/dist/services/sandbox-scope-service.js",
        ),
      ).href;
      const { stdout } = await execFile(
        process.execPath,
        [
          "--import",
          fileURLToPath(new URL("../fixtures/product-path-timing-hook.mjs", import.meta.url)),
          "--input-type=module",
          "-e",
          `import { readFileSync } from 'node:fs';
        import { createHash } from 'node:crypto';
        import { SandboxScopeService } from ${JSON.stringify(scopeModule)};
        const f = JSON.parse(readFileSync(${JSON.stringify(payload)}, 'utf8'));
        let now = ${JSON.stringify(window === "before-parent" ? f.plan.effectiveDeadlineAt : T1)};
        let parents = 0;
        const service = new SandboxScopeService({
          payloads: {get: async () => ({...f.payload, ciphertext: Uint8Array.from(f.payload.ciphertext)})},
          protector: {unprotect: async () => Buffer.from(JSON.stringify(f.scope))},
          files: {readGrant: async () => f.directoryGrant},
          hostId: f.scope.hostId,
          now: () => now,
          digest: bytes => createHash('sha256').update(bytes).digest('hex'),
          verifyParent: async () => {
            parents++;
            if (${JSON.stringify(window)} === 'private-parent') throw new Error('private-token /private/secret.txt');
            now = f.plan.effectiveDeadlineAt;
          },
        });
        try { await service.resolve(f.plan, f.scope.parentRequestId); }
        catch (error) { process.stdout.write(JSON.stringify({message:error.message, parents})); }`,
        ],
        {
          env: {
            ...process.env,
            HIMAWARI_TEST_TIMING_MANIFEST: manifest,
            HIMAWARI_TEST_TIMING_OUTPUT: output,
          },
        },
      );
      expect(JSON.parse(stdout)).toEqual({
        message: "SANDBOX_SCOPE_UNAVAILABLE",
        parents: window === "before-parent" ? 0 : 1,
      });
      const text = await readFile(output, "utf8");
      const events = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "caught_error",
            stage: "agent.scope.resolve",
            jobId: f.plan.identity.jobId,
            failure: expect.objectContaining({
              machineReason:
                window === "during-parent"
                  ? "SANDBOX_SCOPE_EXPIRED"
                  : window === "before-parent"
                    ? "SANDBOX_SCOPE_WINDOW_OR_BINDING_INVALID"
                    : "UNKNOWN",
            }),
          }),
          expect.objectContaining({
            kind: "span",
            stage: "agent.scope.resolve",
            outcome: "threw",
            failure: expect.objectContaining({ machineReason: "SANDBOX_SCOPE_UNAVAILABLE" }),
          }),
        ]),
      );
      expect(text).not.toContain("private-token");
      expect(text).not.toContain("secret.txt");
    } finally {
      vi.unstubAllEnvs();
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
