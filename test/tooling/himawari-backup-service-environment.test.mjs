import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const backup = path.resolve(
  import.meta.dirname,
  "../../scripts/operations/backup/himawari-backup.py",
);
const directories = [];

function executable(file, content) {
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

function host() {
  const root = mkdtempSync(path.join(os.tmpdir(), "backup-env-"));
  directories.push(root);
  const serviceNode = path.join(root, "service-node/bin");
  mkdirSync(serviceNode, { recursive: true });
  executable(
    path.join(serviceNode, "node"),
    '#!/bin/sh\nid=""\nwhile [ $# -gt 0 ]; do [ "$1" = --backup-id ] && id=$2; shift; done\nprintf \'{"fullIntegrityCheck":"ok","backupId":"%s"}\' "$id"\n',
  );
  const buildTools = path.join(root, "build-tools/bin");
  mkdirSync(buildTools, { recursive: true });
  writeFileSync(path.join(buildTools, "node"), "#!/bin/sh\nexit 99\n");
  const release = path.join(root, "releases/2026-11-25-db0859f5");
  mkdirSync(path.join(release, "bin"), { recursive: true });
  executable(path.join(release, "bin/himawari"), '#!/bin/sh\nexec node "$@"\n');
  const unit = path.join(root, "himawari-prod.service");
  writeFileSync(
    unit,
    `[Service]\nEnvironment=PATH=${serviceNode}:/usr/bin:/bin\nEnvironment=HOME=${root}\nExecStart=${release}/bin/himawari\n`,
  );
  return { root, release, unit, buildTools };
}

function createRecoveryPoint({ root, release, unit, buildTools }) {
  const settings = {
    unitPath: unit,
    releasesRoot: path.join(root, "releases"),
    serviceAccount: os.userInfo().username,
    config: path.join(root, "config.json"),
    stateRoot: root,
  };
  const program = [
    "import importlib.util, json, sys, datetime",
    `spec = importlib.util.spec_from_file_location('backup', ${JSON.stringify(backup)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "settings = json.loads(sys.argv[1])",
    "release, cli = module.serving_release(settings)",
    "clock = lambda: datetime.datetime(2026, 11, 26, tzinfo=datetime.timezone.utc)",
    "print(module.create_recovery_point(settings, cli, 'pre-deploy', clock)[0])",
  ].join("\n");
  expect(release).toBeTruthy();
  return spawnSync("python3", ["-I", "-c", program, JSON.stringify(settings)], {
    encoding: "utf8",
    env: { PATH: `${buildTools}:/usr/bin:/bin` },
  });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("himawari-backup service commands", () => {
  it("runs the release CLI with the service's own node, not the caller's PATH", () => {
    const child = createRecoveryPoint(host());
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("auto-pre-deploy-20261126T000000000Z");
  });

  it("refuses when the service unit does not name its PATH", () => {
    const fixture = host();
    writeFileSync(fixture.unit, `[Service]\nExecStart=${fixture.release}/bin/himawari\n`);
    const child = createRecoveryPoint(fixture);
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("BACKUP_SERVICE_ENVIRONMENT_UNKNOWN");
  });
});
