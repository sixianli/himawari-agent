import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseUserComputerConfig } from "../src/user-computer/config.ts";
import { CallAllowlist, normalizeAllowedDomains } from "../src/user-computer/egress.ts";
import { computerOwnerKey } from "../src/user-computer/manager.ts";
import { decideAdmission, hostAvailableMemoryBytes } from "../src/user-computer/memory.ts";

const MIB = 1024 * 1024;

function validConfig(): Record<string, unknown> {
  return {
    schemaVersion: "user-computers.v1",
    docker: { executable: "/usr/bin/docker", host: null },
    runtime: "runsc",
    image: { reference: "ghcr.io/example/computer", digest: `sha256:${"a".repeat(64)}` },
    stateDirectory: "/var/lib/himawari-computers",
    socket: { path: "/run/himawari-computers/computers.sock", groupId: 998 },
    disk: { mode: "loop", sizeBytes: 10 * 1024 * MIB },
    resources: { memoryBytes: 2048 * MIB, cpus: 1, maxProcesses: 512 },
    admission: { startBytes: 512 * MIB, reserveBytes: 4096 * MIB, waitMs: 120_000, pollMs: 2000 },
    idle: { stopAfterMs: 900_000, checkIntervalMs: 60_000, staleAfterMs: 2_592_000_000 },
    commandTimeoutMs: 60_000,
    stopGraceSeconds: 5,
    beforeStop: { argv: ["himawari-browser", "stop"], timeoutSeconds: 10 },
  };
}

describe("电脑配置", () => {
  it("完整配置原样读出", () => {
    expect(parseUserComputerConfig(validConfig()).disk).toEqual({
      mode: "loop",
      sizeBytes: 10 * 1024 * MIB,
    });
  });

  it.each([
    ["多出字段", { ...validConfig(), extra: true }],
    ["缺字段", { ...validConfig(), idle: { stopAfterMs: 1, checkIntervalMs: 1 } }],
    ["镜像没锁摘要", { ...validConfig(), image: { reference: "x", digest: "latest" } }],
    ["相对路径", { ...validConfig(), stateDirectory: "state" }],
    ["未知磁盘方式", { ...validConfig(), disk: { mode: "tmpfs", sizeBytes: 1 } }],
    [
      "空闲时长为 0",
      { ...validConfig(), idle: { ...(validConfig()["idle"] as object), stopAfterMs: 0 } },
    ],
  ])("拒绝：%s", (_name, input) => {
    expect(() => parseUserComputerConfig(input)).toThrow(/USER_COMPUTER_CONFIG_INVALID/);
  });
});

describe("开机名额", () => {
  it("剩余内存够就直接开", () => {
    expect(
      decideAdmission({
        availableBytes: 6000 * MIB,
        startBytes: 512 * MIB,
        reserveBytes: 4096 * MIB,
        running: [],
      }),
    ).toEqual({ kind: "start" });
  });

  it("不够时关最久没用的空闲电脑，正在用的不关", () => {
    expect(
      decideAdmission({
        availableBytes: 4200 * MIB,
        startBytes: 512 * MIB,
        reserveBytes: 4096 * MIB,
        running: [
          { ownerKey: "busy", activeCalls: 1, lastActivityMs: 1 },
          { ownerKey: "newer", activeCalls: 0, lastActivityMs: 30 },
          { ownerKey: "older", activeCalls: 0, lastActivityMs: 20 },
        ],
      }),
    ).toEqual({ kind: "evict", ownerKey: "older" });
  });

  it("都在用就排队，并写明在等什么", () => {
    const decision = decideAdmission({
      availableBytes: 4200 * MIB,
      startBytes: 512 * MIB,
      reserveBytes: 4096 * MIB,
      running: [{ ownerKey: "busy", activeCalls: 2, lastActivityMs: 1 }],
    });
    expect(decision).toEqual({
      kind: "wait",
      detail: "等内存：开一台电脑要 512 MiB，东京机现在可用 104 MiB，开着的 1 台电脑都正在用",
    });
  });

  it("从 /proc/meminfo 读当前可用内存", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "meminfo-"));
    const file = path.join(directory, "meminfo");
    await writeFile(file, "MemTotal:       24000000 kB\nMemAvailable:    1024 kB\n");
    expect(await hostAvailableMemoryBytes(file)).toBe(1024 * 1024);
  });
});

describe("出口放行清单", () => {
  it("只写主机名时放行 443 和 80，写端口时只放行那个端口", () => {
    expect(normalizeAllowedDomains(["Example.com", "api.example.com:8443"])).toEqual([
      "api.example.com:8443",
      "example.com:443",
      "example.com:80",
    ]);
  });

  it.each(["", "http://example.com", "exa mple.com", "example.com:0", "example.com:70000"])(
    "拒绝不合格的网址 %s",
    (entry) => {
      expect(() => normalizeAllowedDomains([entry])).toThrow(/COMPUTER_DOMAIN_INVALID/);
    },
  );

  it("放行的是正在跑的调用的并集，调用结束就收回", () => {
    const allowlist = new CallAllowlist();
    expect(allowlist.allows("example.com:443")).toBe(false);
    const first = allowlist.open(["example.com:443"]);
    const second = allowlist.open(["other.com:443"]);
    expect(allowlist.allows("example.com:443")).toBe(true);
    expect(allowlist.allows("other.com:443")).toBe(true);
    first();
    expect(allowlist.allows("example.com:443")).toBe(false);
    second();
    expect(allowlist.allows("other.com:443")).toBe(false);
  });
});

describe("用户键", () => {
  it("同一个人永远同一台，不同的人不同", () => {
    expect(computerOwnerKey("owner-a")).toBe(computerOwnerKey("owner-a"));
    expect(computerOwnerKey("owner-a")).not.toBe(computerOwnerKey("owner-b"));
    expect(computerOwnerKey("owner-a")).toMatch(/^[a-f0-9]{24}$/);
  });
});
