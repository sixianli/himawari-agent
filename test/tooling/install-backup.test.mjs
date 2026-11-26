import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const installer = path.resolve(
  import.meta.dirname,
  "../../scripts/operations/backup/install-backup.sh",
);
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function productionShape() {
  const root = mkdtempSync(path.join(os.tmpdir(), "install-backup-"));
  directories.push(root);
  const secrets = path.join(root, "var/lib/himawari/state/secrets");
  mkdirSync(secrets, { recursive: true });
  writeFileSync(path.join(secrets, "payload-key.v1"), "11".repeat(32), { mode: 0o600 });
  mkdirSync(path.join(root, "etc/himawari"), { recursive: true });
  const configPath = path.join(root, "etc/himawari/config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({
      deploymentId: "d",
      secretReferences: [
        { ref: "vercel-gateway", version: "v1", purpose: "model-provider", scope: "prod" },
        { ref: "payload-key", version: "v1", purpose: "payload-encryption", scope: "prod" },
      ],
    })}\n`,
    { mode: 0o640 },
  );
  const rclone = path.join(root, "usr/local/bin/rclone");
  mkdirSync(path.dirname(rclone), { recursive: true });
  writeFileSync(rclone, "#!/bin/sh\necho rclone v1.71.2\n");
  chmodSync(rclone, 0o755);
  const metadata = path.join(root, "metadata.json");
  writeFileSync(
    metadata,
    JSON.stringify({
      canonicalRegionName: "ap-tokyo-1",
      compartmentId: "ocid1.tenancy.oc1..aaaaexample",
    }),
  );
  return { root, secrets, configPath, metadata };
}

function install(shape) {
  return spawnSync(
    "bash",
    [installer, "install", "--namespace", "nsexample", "--bucket", "himawari-backup"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        BACKUP_ROOT: shape.root,
        BACKUP_SYSTEMCTL: "true",
        BACKUP_METADATA_URL: `file://${shape.metadata}`,
      },
    },
  );
}

describe("install-backup.sh", () => {
  it("adds a backup-encryption key once when the production config has none", () => {
    const shape = productionShape();
    const first = install(shape);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("BACKUP_KEY_CREATED backup-key.v1");
    const key = readFileSync(path.join(shape.secrets, "backup-key.v1"), "utf8");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path.join(shape.secrets, "backup-key.v1")).mode & 0o777).toBe(0o600);
    const config = JSON.parse(readFileSync(shape.configPath, "utf8"));
    expect(config.secretReferences).toContainEqual({
      ref: "backup-key",
      version: "v1",
      purpose: "backup-encryption",
      scope: "prod",
    });
    expect(statSync(shape.configPath).mode & 0o777).toBe(0o640);

    const second = install(shape);
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain("BACKUP_KEY_CREATED");
    expect(readFileSync(path.join(shape.secrets, "backup-key.v1"), "utf8")).toBe(key);
    const again = JSON.parse(readFileSync(shape.configPath, "utf8"));
    expect(
      again.secretReferences.filter((entry) => entry.purpose === "backup-encryption"),
    ).toHaveLength(1);
  });

  it("refuses when the config has no single payload key to copy the scope from", () => {
    const shape = productionShape();
    writeFileSync(shape.configPath, `${JSON.stringify({ secretReferences: [] })}\n`);
    const result = install(shape);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("BACKUP_INSTALL_REFUSED PAYLOAD_KEY_UNKNOWN");
  });
});
