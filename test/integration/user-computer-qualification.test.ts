import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computerNames,
  computerOwnerKey,
  parseUserComputerConfig,
  UserComputerClient,
  UserComputerError,
  UserComputerManager,
  serveUserComputers,
} from "@himawari-agent/runtime-sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env["HIMAWARI_COMPUTER_QUALIFICATION"] === "1";
const computerDescribe = enabled ? describe : describe.skip;
const runtime = process.env["HIMAWARI_COMPUTER_RUNTIME"] ?? "runc";
const dockerExecutable = process.env["HIMAWARI_CONTAINER_DOCKER_CLI"] ?? "/usr/bin/docker";
const IMAGE = {
  reference: "docker.io/library/alpine",
  digest: "sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
};
const DISK_BYTES = 64 * 1024 * 1024;

function config(stateDirectory: string, socketPath: string) {
  return parseUserComputerConfig({
    schemaVersion: "user-computers.v1",
    docker: { executable: dockerExecutable, host: null },
    runtime,
    image: IMAGE,
    stateDirectory,
    socket: { path: socketPath, groupId: null },
    disk: { mode: "loop", sizeBytes: DISK_BYTES },
    resources: { memoryBytes: 256 * 1024 * 1024, cpus: 0.5, maxProcesses: 128 },
    admission: { startBytes: 64 * 1024 * 1024, reserveBytes: 0, waitMs: 1500, pollMs: 250 },
    idle: { stopAfterMs: 15 * 60 * 1000, checkIntervalMs: 60_000, staleAfterMs: 30 * 86_400_000 },
    commandTimeoutMs: 60_000,
    stopGraceSeconds: 1,
    beforeStop: { argv: ["sh", "-c", "date > /home/himawari/.stopped-cleanly"], timeoutSeconds: 5 },
  });
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

computerDescribe("每人一台电脑（真实 Docker）", () => {
  const run = Math.random().toString(16).slice(2, 10);
  const userA = `qualification-a-${run}`;
  const userB = `qualification-b-${run}`;
  let root = "";
  let clock = Date.now();
  let roomForOne = false;
  const deadline = () => new Date(clock + 60_000).toISOString();
  let manager: UserComputerManager;
  let client: UserComputerClient;
  let closeServer = async () => {};

  const shell = (ownerId: string, script: string, allowedDomains: readonly string[] = []) =>
    client.exec({
      ownerId,
      argv: ["sh", "-c", script],
      allowedDomains,
      deadlineAt: deadline(),
      maxOutputBytes: 64 * 1024,
    });

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "himawari-computer-"));
    const socketPath = path.join(root, "computers.sock");
    manager = new UserComputerManager(config(path.join(root, "state"), socketPath), {
      now: () => clock,
      availableMemoryBytes: async () => {
        if (!roomForOne) return Number.MAX_SAFE_INTEGER;
        const running = (await manager.status()).filter((item) => item.state === "running");
        return running.length === 0 ? Number.MAX_SAFE_INTEGER : 0;
      },
    });
    const server = await serveUserComputers(manager, socketPath);
    closeServer = () => new Promise((resolve) => server.close(() => resolve()));
    client = new UserComputerClient(socketPath);
  }, 120_000);

  afterAll(async () => {
    for (const owner of [userA, userB]) await manager.deleteComputer(owner).catch(() => undefined);
    await closeServer();
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }, 120_000);

  it("第一次用时开机，在电脑里执行并读写家目录", async () => {
    const result = await shell(
      userA,
      'echo "$HOME"; mkdir -p .local/lib; echo kept > .local/lib/marker; cat .local/lib/marker',
    );
    expect(result.exitCode).toBe(0);
    expect(decode(result.stdout)).toBe("/home/himawari\nkept\n");
    const [status] = (await manager.status()).filter(
      (item) => item.ownerKey === computerOwnerKey(userA),
    );
    expect(status?.state).toBe("running");
  }, 300_000);

  it("标准输入、退出码和输出上限都如实交回", async () => {
    const echoed = await client.exec({
      ownerId: userA,
      argv: ["cat"],
      stdin: new TextEncoder().encode("from stdin"),
      allowedDomains: [],
      deadlineAt: deadline(),
      maxOutputBytes: 4,
    });
    expect(decode(echoed.stdout)).toBe("from");
    expect(echoed.truncated).toBe(true);
    const failed = await shell(userA, "echo oops >&2; exit 7");
    expect(failed.exitCode).toBe(7);
    expect(decode(failed.stderr)).toBe("oops\n");
  }, 120_000);

  it("空闲够久就关机，再用时开机，家目录里的东西还在", async () => {
    clock += 60 * 1000;
    expect(await manager.stopIdle()).toEqual([]);
    clock += 15 * 60 * 1000;
    expect(await manager.stopIdle()).toEqual([computerOwnerKey(userA)]);
    const [stopped] = (await manager.status()).filter(
      (item) => item.ownerKey === computerOwnerKey(userA),
    );
    expect(stopped?.state).toBe("stopped");
    const result = await shell(
      userA,
      "cat .local/lib/marker; test -s .stopped-cleanly && echo hook-ran",
    );
    expect(decode(result.stdout)).toBe("kept\nhook-ran\n");
  }, 300_000);

  it("反向：用户 B 看不到 A 的文件，也连不到 A 的电脑", async () => {
    const own = await shell(userB, "ls -A /home/himawari | grep -v lost+found; echo done");
    expect(decode(own.stdout)).toBe("done\n");
    const { execFileSync } = await import("node:child_process");
    const docker = (args: string[]) =>
      execFileSync(dockerExecutable, args, { encoding: "utf8" }).trim();
    const namesA = computerNames(computerOwnerKey(userA));
    await shell(userA, "(nc -lk -p 8080 -e echo from-a >/dev/null 2>&1 &)");
    const local = await shell(userA, "nc -w 3 127.0.0.1 8080 </dev/null");
    expect(decode(local.stdout)).toBe("from-a\n");
    const addressA = docker([
      "container",
      "inspect",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      namesA.container,
    ]);
    expect(addressA).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const sameNetwork = docker([
      "run",
      "--rm",
      "--network",
      namesA.network,
      `${IMAGE.reference}@${IMAGE.digest}`,
      "sh",
      "-c",
      `nc -w 3 ${addressA} 8080 </dev/null || echo blocked`,
    ]);
    expect(sameNetwork).toBe("from-a");
    const fromB = await shell(
      userB,
      `nc -w 3 ${addressA} 8080 </dev/null 2>/dev/null || echo blocked`,
    );
    expect(decode(fromB.stdout)).toBe("blocked\n");
  }, 300_000);

  it("只放行这次调用给的网址，别的网址代理拒绝", async () => {
    const denied = await shell(
      userA,
      'wget -q -O /dev/null -T 10 http://example.com/ 2>&1; echo "exit=$?"',
    );
    expect(decode(denied.stdout)).toMatch(/403|exit=1/);
    const allowed = await shell(
      userA,
      'wget -q -O - -T 20 http://example.com/ | grep -o "Example Domain" | head -1',
      ["example.com"],
    );
    expect(decode(allowed.stdout)).toBe("Example Domain\n");
  }, 120_000);

  it("磁盘写满就写不进", async () => {
    const result = await shell(
      userB,
      'dd if=/dev/zero of=/home/himawari/fill bs=1M count=200 2>/dev/null; echo "exit=$?"; rm -f /home/himawari/fill',
    );
    expect(decode(result.stdout)).toBe("exit=1\n");
  }, 120_000);

  it("内存不够时先关最久没用的空闲电脑，还不够就报在等什么", async () => {
    clock += 20 * 60 * 1000;
    await manager.stopIdle();
    await shell(userA, "true");
    clock += 60 * 1000;
    roomForOne = true;
    await expect(shell(userB, "true")).resolves.toMatchObject({ exitCode: 0 });
    const states = await manager.status();
    expect(states.find((item) => item.ownerKey === computerOwnerKey(userA))?.state).toBe("stopped");
    const busy = shell(userB, "sleep 4");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const waited = await shell(userA, "true").catch((error: unknown) => error);
    await busy;
    expect(waited).toBeInstanceOf(UserComputerError);
    expect((waited as UserComputerError).code).toBe("COMPUTER_WAITING_FOR_MEMORY");
    expect((waited as UserComputerError).detail).toContain("等内存");
    roomForOne = false;
  }, 300_000);
});
