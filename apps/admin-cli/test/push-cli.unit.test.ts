import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { SystemdCredentialSecretSource, webPushPublicKey } from "@himawari-agent/platform-node";
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

it("[WP-7] writes one web push key the service can read and never overwrites it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-push-cli-"));
  try {
    const secrets = path.join(root, "secrets");
    await mkdir(secrets, { mode: 0o700 });
    await chmod(secrets, 0o700);
    const output = capture();
    expect(await runAdminCli(["push", "init-key", "--state-root", root], output.stream)).toBe(0);
    const result = output.json();
    expect(result).toMatchObject({
      command: "push.init-key",
      secretFile: path.join(secrets, "web-push-vapid.v1"),
      configuration: {
        secretReference: { ref: "web-push-vapid", version: "v1", purpose: "web-push" },
        runPolicy: { webPush: { secretRef: "web-push-vapid" } },
      },
    });
    expect(((await lstat(result.secretFile)).mode & 0o777).toString(8)).toBe("600");
    const key = await new SystemdCredentialSecretSource(secrets).resolve("web-push-vapid", "v1");
    expect(webPushPublicKey(key)).toBe(result.publicKey);
    expect(JSON.stringify(result)).not.toContain(Buffer.from(key).toString("base64"));

    const again = capture();
    const errors = capture();
    expect(
      await runAdminCli(["push", "init-key", "--state-root", root], again.stream, errors.stream),
    ).toBe(1);
    expect(errors.json()).toEqual({ error: { code: "PUSH_SECRET_EXISTS" } });
    const unchanged = await new SystemdCredentialSecretSource(secrets).resolve(
      "web-push-vapid",
      "v1",
    );
    expect(Buffer.from(unchanged).equals(Buffer.from(key))).toBe(true);

    await chmod(secrets, 0o755);
    expect(
      await runAdminCli(["push", "init-key", "--state-root", root], again.stream, errors.stream),
    ).toBe(1);
    expect(errors.json()).toEqual({ error: { code: "PUSH_SECRET_DIRECTORY_INVALID" } });
  } finally {
    await rm(root, { recursive: true });
  }
});
