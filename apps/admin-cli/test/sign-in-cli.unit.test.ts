import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  FileSetupCodeSource,
  hashSetupCode,
  initializeStateRoot,
  normalizeSetupCode,
} from "@himawari-agent/platform-node";
import { expect, it } from "vitest";
import { runAdminCli } from "../src/index.js";

function capture() {
  let text = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        text += String(chunk);
        callback();
      },
    }),
    json: () => JSON.parse(text.trim().split("\n").at(-1) ?? "{}"),
  };
}

async function configuration(root: string) {
  const stateRoot = path.join(root, "state");
  const layout = await initializeStateRoot(stateRoot);
  const source = JSON.parse(
    await readFile(
      new URL(
        "../../../test/integration/fixtures/file-summary/configuration.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const file = path.join(root, "config.json");
  await writeFile(
    file,
    JSON.stringify({
      ...source,
      stateRoot,
      runtimeDirectory: layout.runtime,
      cacheDirectory: layout.cache,
      memory: { ...source.memory, storagePath: path.join(layout.data, "memory") },
    }),
    { mode: 0o600 },
  );
  return { file, stateRoot, ownerId: source.ownerId as string };
}

it("[ADR-0309] prints a one-time setup code and leaves only its hash for the running service", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-sign-in-cli-"));
  try {
    const config = await configuration(root);
    const output = capture();
    expect(
      await runAdminCli(["sign-in", "setup-code", "--config", config.file], output.stream),
    ).toBe(0);
    const result = output.json() as { command: string; setupCode: string; expiresAt: string };
    expect(result.command).toBe("sign-in.setup-code");
    expect(result.setupCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
    const minutes = (Date.parse(result.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    const stored = await new FileSetupCodeSource(config.stateRoot).read();
    expect(stored?.ownerId).toBe(config.ownerId);
    expect(stored?.codeHash).toBe(hashSetupCode(normalizeSetupCode(result.setupCode) as string));
    const raw = await readFile(path.join(config.stateRoot, "sign-in", "setup-code.json"), "utf8");
    expect(raw).not.toContain(result.setupCode.replace("-", ""));

    const longer = capture();
    expect(
      await runAdminCli(
        ["sign-in", "setup-code", "--config", config.file, "--minutes", "60"],
        longer.stream,
      ),
    ).toBe(0);
    const replaced = await new FileSetupCodeSource(config.stateRoot).read();
    expect(replaced?.codeHash).not.toBe(stored?.codeHash);

    for (const bad of [
      ["sign-in", "setup-code"],
      ["sign-in", "setup-code", "--config", config.file, "--minutes", "0"],
      ["sign-in", "setup-code", "--config", config.file, "--minutes", "1441"],
      ["sign-in", "setup-code", "--config", config.file, "--minutes", "1.5"],
      ["sign-in", "setup-code", "--config", config.file, "--other", "x"],
      ["sign-in", "reset"],
    ]) {
      const errors = capture();
      expect(await runAdminCli(bad, capture().stream, errors.stream), bad.join(" ")).toBe(1);
      expect(errors.json()).toEqual({ error: { code: "ADMIN_SIGN_IN_ARGUMENT_INVALID" } });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
