import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseUserComputerConfig } from "../../packages/runtime-sandbox/src/user-computer/config.ts";

const root = path.resolve(import.meta.dirname, "../..");
const installer = path.join(root, "scripts/operations/computers/install-computers.sh");
const settings = JSON.parse(
  readFileSync(path.join(root, "scripts/operations/computers/settings.json"), "utf8"),
);
const directories = [];
const digest = `sha256:${"b".repeat(64)}`;

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function render(release, imageDigest = digest) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "install-computers-"));
  directories.push(directory);
  const config = path.join(directory, "config.json");
  const unit = path.join(directory, "himawari-computers.service");
  const child = spawnSync(
    "bash",
    [
      installer,
      "render",
      "--release",
      release,
      "--image-digest",
      imageDigest,
      "--group-id",
      "998",
      "--config",
      config,
      "--unit",
      unit,
    ],
    { encoding: "utf8" },
  );
  return { child, config, unit };
}

describe("每人一台电脑的生产安装", () => {
  it("写出的电脑配置能被电脑管理读进去，数值来自 settings.json", () => {
    const release = "/opt/himawari/releases/2026-11-27-0123abc";
    const { child, config, unit } = render(release);
    expect(child.status, child.stderr).toBe(0);
    const parsed = parseUserComputerConfig(JSON.parse(readFileSync(config, "utf8")));
    expect(parsed.image).toEqual({ reference: null, digest });
    expect(parsed.socket).toEqual({ path: settings.paths.socket, groupId: 998 });
    expect(parsed.disk).toEqual(settings.computer.disk);
    expect(parsed.idle).toEqual(settings.computer.idle);
    expect(parsed.hostPaths).toEqual({
      runtimeRoots: settings.paths.runtimeRoots,
      seedRoots: settings.paths.seedRoots,
    });
    const hostMain = `${release}/lib/himawari-agent/node_modules/@himawari-agent/runtime-sandbox/dist/user-computer/host-main.js`;
    expect(child.stdout.trim()).toBe(hostMain);
    expect(readFileSync(unit, "utf8")).toContain(
      `ExecStart=${settings.paths.node} --no-global-search-paths ${hostMain} --config ${settings.paths.config}`,
    );
  });

  it("REVERSE: 不在程序目录白名单下的版本、坏摘要都拒绝，什么也不写", () => {
    const outside = render("/tmp/releases/2026-11-27-0123abc");
    expect(outside.child.status).not.toBe(0);
    expect(outside.child.stderr).toContain("COMPUTERS_RELEASE_OUTSIDE_RUNTIME_ROOTS");
    const escaped = render("/opt/himawari/releases/../etc");
    expect(escaped.child.stderr).toContain("COMPUTERS_RELEASE_INVALID");
    const badDigest = render("/opt/himawari/releases/2026-11-27-0123abc", "latest");
    expect(badDigest.child.stderr).toContain("COMPUTERS_IMAGE_DIGEST_INVALID");
    for (const result of [outside, escaped, badDigest])
      expect(() => readFileSync(result.config)).toThrow();
  });

  it("生产装的 gVisor 和 CI 资格测试用的是同一个锁定版本", () => {
    const workflow = readFileSync(path.join(root, ".github/workflows/user-computer.yml"), "utf8");
    expect(workflow).toContain(`GVISOR_RELEASE: ${settings.gvisor.release}`);
    expect(workflow).toContain(`GVISOR_SHA512: ${settings.gvisor.sha512.aarch64}`);
  });

  it("不是 root 时 ensure 直接拒绝", () => {
    if (process.getuid?.() === 0) return;
    const child = spawnSync(
      "bash",
      [installer, "ensure", "--release", "/opt/himawari/releases/x"],
      {
        encoding: "utf8",
      },
    );
    expect(child.status).toBe(77);
    expect(child.stderr).toContain("NEEDS_ROOT");
  });
});
