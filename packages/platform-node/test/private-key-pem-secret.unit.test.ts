import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readRestrictedPrivateKeyPem } from "../src/index.js";

it("[OUTAGE-4] reads an Apple push signing key stored as one PEM file and refuses anything else", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-pem-secret-"));
  try {
    const secrets = path.join(root, "secrets");
    await mkdir(secrets, { mode: 0o700 });
    const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    await writeFile(path.join(secrets, "apns.v1"), pem, { mode: 0o600 });
    expect(new TextDecoder().decode(await readRestrictedPrivateKeyPem(secrets, "apns", "v1"))).toBe(
      pem,
    );

    await writeFile(path.join(secrets, "raw.v1"), randomBytes(32).toString("base64"), {
      mode: 0o600,
    });
    await writeFile(
      path.join(secrets, "garbled.v1"),
      ["BEGIN", "END"].map((edge) => `-----${edge} PRIVATE KEY-----`).join("\nbm90IGEga2V5\n"),
      { mode: 0o600 },
    );
    for (const ref of ["raw", "garbled"])
      await expect(readRestrictedPrivateKeyPem(secrets, ref, "v1")).rejects.toMatchObject({
        code: "HOST_SECRET_INVALID_KEY_MATERIAL",
      });

    await chmod(path.join(secrets, "apns.v1"), 0o640);
    await expect(readRestrictedPrivateKeyPem(secrets, "apns", "v1")).rejects.toMatchObject({
      code: "HOST_SECRET_SOURCE_UNSAFE",
    });
    await expect(readRestrictedPrivateKeyPem("relative", "apns", "v1")).rejects.toMatchObject({
      code: "HOST_SECRET_SOURCE_UNSAFE",
    });
  } finally {
    await rm(root, { recursive: true });
  }
});
