import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HostDirectoryGrant } from "@himawari-agent/application";
import {
  computerNames,
  computerOwnerKey,
  parseUserComputerConfig,
  serveUserComputers,
  UserComputerClient,
  UserComputerError,
  UserComputerManager,
} from "@himawari-agent/runtime-sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BROWSER_CAPABILITY_REF,
  BrowserToolError,
  ProductionBrowserTools,
} from "../../apps/agent-service/src/production-browser-tools.ts";
import {
  type ComputerToolName,
  createProductionComputerTools,
  type ProductionComputerTools,
} from "../../apps/agent-service/src/production-computer-tools.ts";

const enabled = process.env["HIMAWARI_COMPUTER_QUALIFICATION"] === "1";
const computerDescribe = enabled ? describe : describe.skip;
const runtime = process.env["HIMAWARI_COMPUTER_RUNTIME"] ?? "runc";
const dockerExecutable = process.env["HIMAWARI_CONTAINER_DOCKER_CLI"] ?? "/usr/bin/docker";
const IMAGE = {
  reference: "docker.io/library/alpine",
  digest: "sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
};
const DISK_BYTES = 64 * 1024 * 1024;
const RUNTIME_ROOT = path.resolve("dist/node-runtime");

function config(stateDirectory: string, socketPath: string, hostRoot: string) {
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
    hostPaths: {
      runtimeRoots: [path.join(hostRoot, "runtimes")],
      seedRoots: [path.join(hostRoot, "seeds")],
    },
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
    for (const directory of ["runtimes/v1", "runtimes/v2", "seeds/project", "elsewhere"])
      await mkdir(path.join(root, directory), { recursive: true });
    manager = new UserComputerManager(config(path.join(root, "state"), socketPath, root), {
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

  it("第一次用时把原工作目录复制进电脑，只复制一次；授权根以外的目录不复制", async () => {
    const source = path.join(root, "seeds", "project");
    await mkdir(path.join(source, "notes"), { recursive: true });
    await writeFile(path.join(source, "notes", "hello.txt"), "original\n");
    const first = await client.seedWorkspace({ ownerId: userA, source });
    expect(first).toMatchObject({ copied: true });
    expect(first.seededAt).not.toBeNull();
    await writeFile(path.join(source, "notes", "hello.txt"), "changed on host\n");
    const second = await client.seedWorkspace({ ownerId: userA, source });
    expect(second).toMatchObject({ copied: false, seededAt: first.seededAt });
    const inside = await shell(userA, "cat /home/himawari/workspace/notes/hello.txt");
    expect(decode(inside.stdout)).toBe("original\n");
    const outside = await client
      .seedWorkspace({ ownerId: userB, source: path.join(root, "elsewhere") })
      .catch((error: unknown) => error);
    expect((outside as UserComputerError).code).toBe("COMPUTER_REQUEST_INVALID");
    const escaped = await client
      .seedWorkspace({ ownerId: userB, source: path.join(root, "seeds", "..", "elsewhere") })
      .catch((error: unknown) => error);
    expect((escaped as UserComputerError).code).toBe("COMPUTER_REQUEST_INVALID");
    const empty = await shell(userB, "test -e /home/himawari/workspace && echo found || echo none");
    expect(decode(empty.stdout)).toBe("none\n");
  }, 300_000);

  it("程序目录只读挂进电脑，换版本时重建电脑但家目录还在", async () => {
    await writeFile(path.join(root, "runtimes", "v1", "marker"), "v1\n");
    await writeFile(path.join(root, "runtimes", "v2", "marker"), "v2\n");
    const withRuntime = (version: string, script: string) =>
      client.exec({
        ownerId: userA,
        argv: ["sh", "-c", script],
        allowedDomains: [],
        deadlineAt: deadline(),
        maxOutputBytes: 4096,
        runtime: path.join(root, "runtimes", version),
      });
    const first = await withRuntime(
      "v1",
      "cat /opt/himawari/marker; touch /opt/himawari/written 2>/dev/null || echo read-only",
    );
    expect(decode(first.stdout)).toBe("v1\nread-only\n");
    const unchanged = await shell(userA, "cat /opt/himawari/marker");
    expect(decode(unchanged.stdout)).toBe("v1\n");
    const second = await withRuntime(
      "v2",
      "cat /opt/himawari/marker; cat /home/himawari/workspace/notes/hello.txt",
    );
    expect(decode(second.stdout)).toBe("v2\noriginal\n");
    const rejected = await client
      .exec({
        ownerId: userA,
        argv: ["true"],
        allowedDomains: [],
        deadlineAt: deadline(),
        maxOutputBytes: 64,
        runtime: path.join(root, "elsewhere"),
      })
      .catch((error: unknown) => error);
    expect((rejected as UserComputerError).code).toBe("COMPUTER_REQUEST_INVALID");
  }, 300_000);

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

const toolsImage = process.env["HIMAWARI_COMPUTER_TOOLS_IMAGE"] ?? "";
const toolsDescribe = enabled && toolsImage ? describe : describe.skip;

toolsDescribe("七个编码工具在主人自己的电脑里跑（真实镜像和 Pi 运行器）", () => {
  const run = Math.random().toString(16).slice(2, 10);
  const owner = `tools-a-${run}`;
  const stranger = `tools-b-${run}`;
  let root = "";
  let manager: UserComputerManager;
  let closeServer = async () => {};
  let tools: ProductionComputerTools;
  let grantA: HostDirectoryGrant;
  let grantB: HostDirectoryGrant;

  const grantFor = (id: string, displayPath: string): HostDirectoryGrant => ({
    id,
    revision: 1,
    hostId: "qualification-host",
    canonicalRootId: `${id}-root`,
    displayPath,
    operations: ["read", "create", "update"],
    authorizationRef: `${id}-authorization`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revokedAt: null,
    dataClassification: "private",
    disclosure: "model",
    pathPolicy: "same_filesystem_no_links",
    mountPolicy: "fixed_device",
  });

  const call = (
    grant: HostDirectoryGrant,
    tool: ComputerToolName,
    parameters: Record<string, unknown>,
    ownerId = owner,
  ) =>
    tools.execute({
      ownerId,
      tool,
      toolCallId: `call-${Math.random().toString(16).slice(2)}`,
      hostId: grant.hostId,
      grant,
      parameters,
      relativePath: typeof parameters["path"] === "string" ? String(parameters["path"]) : null,
      maximumOutputBytes: 256 * 1024,
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    });

  const text = (result: { readonly modelContent: string }) => {
    const parsed = JSON.parse(result.modelContent) as {
      readonly content: readonly { readonly text?: string }[];
    };
    return parsed.content.map((part) => part.text ?? "").join("\n");
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "himawari-computer-tools-"));
    const socketPath = path.join(root, "computers.sock");
    const projectA = path.join(root, "seeds", "project-a");
    const projectB = path.join(root, "seeds", "project-b");
    await mkdir(path.join(projectA, "docs"), { recursive: true });
    await mkdir(projectB, { recursive: true });
    await writeFile(path.join(projectA, "docs", "plan.md"), "# 计划\n向日葵 sunflower\n");
    await writeFile(path.join(projectB, "readme.txt"), "stranger\n");
    grantA = grantFor("grant-a", projectA);
    grantB = grantFor("grant-b", projectB);
    const configuration = parseUserComputerConfig({
      schemaVersion: "user-computers.v1",
      docker: { executable: dockerExecutable, host: null },
      runtime,
      image: { reference: null, digest: toolsImage },
      stateDirectory: path.join(root, "state"),
      socket: { path: socketPath, groupId: null },
      disk: { mode: "loop", sizeBytes: 512 * 1024 * 1024 },
      resources: { memoryBytes: 1024 * 1024 * 1024, cpus: 1, maxProcesses: 256 },
      admission: { startBytes: 64 * 1024 * 1024, reserveBytes: 0, waitMs: 1000, pollMs: 250 },
      idle: { stopAfterMs: 900_000, checkIntervalMs: 60_000, staleAfterMs: 30 * 86_400_000 },
      commandTimeoutMs: 120_000,
      stopGraceSeconds: 1,
      beforeStop: null,
      hostPaths: { runtimeRoots: [RUNTIME_ROOT], seedRoots: [path.join(root, "seeds")] },
    });
    manager = new UserComputerManager(configuration);
    const server = await serveUserComputers(manager, socketPath);
    closeServer = () => new Promise((resolve) => server.close(() => resolve()));
    tools = createProductionComputerTools({
      computers: new UserComputerClient(socketPath),
      runtimeRoot: () => RUNTIME_ROOT,
      networkDomains: () => [],
    });
  }, 120_000);

  afterAll(async () => {
    for (const ownerId of [owner, stranger])
      await manager.deleteComputer(ownerId).catch(() => undefined);
    await closeServer();
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }, 120_000);

  it("第一次调用把原工作目录复制进电脑，读、列、找、搜都在电脑里完成", async () => {
    const read = await call(grantA, "read", { path: "docs/plan.md" });
    expect(read.isError).toBe(false);
    expect(text(read)).toContain("向日葵 sunflower");
    const listed = await call(grantA, "ls", { path: "" });
    expect(text(listed)).toContain("docs/");
    const found = await call(grantA, "find", { pattern: "*.md" });
    expect(text(found)).toContain("docs/plan.md");
    const searched = await call(grantA, "grep", { pattern: "sunflower" });
    expect(text(searched)).toContain("plan.md");
  }, 300_000);

  it("写和改落在电脑的家目录里，不碰原目录；bash 也在同一个工作目录", async () => {
    const written = await call(grantA, "write", { path: "notes/today.md", content: "第一行\n" });
    expect(written.isError).toBe(false);
    const edited = await call(grantA, "edit", {
      path: "notes/today.md",
      edits: [{ oldText: "第一行", newText: "改过的第一行" }],
    });
    expect(edited.isError).toBe(false);
    const shell = await call(grantA, "bash", {
      command: `pwd; cat notes/today.md; cat ${grantA.displayPath}/notes/today.md; python3 -c 'import sys; print(sys.version_info[0])'`,
    });
    expect(shell.isError).toBe(false);
    expect(text(shell)).toContain("/home/himawari/workspace\n改过的第一行\n改过的第一行\n3");
    await expect(
      readFile(path.join(grantA.displayPath, "notes", "today.md"), "utf8"),
    ).rejects.toThrow();
  }, 300_000);

  it("反向：另一个主人的电脑里读不到这个主人的文件", async () => {
    const own = await call(grantB, "read", { path: "readme.txt" }, stranger);
    expect(text(own)).toContain("stranger");
    const foreign = await call(grantB, "read", { path: "docs/plan.md" }, stranger);
    expect(foreign.isError).toBe(true);
    const shell = await call(
      grantB,
      "bash",
      {
        command:
          "ls /home/himawari/workspace; cat /home/himawari/workspace/notes/today.md 2>&1 || true",
      },
      stranger,
    );
    expect(text(shell)).not.toContain("改过的第一行");
    expect(text(shell)).toContain("readme.txt");
  }, 300_000);
});

toolsDescribe("浏览器在主人自己的电脑里跑（真实镜像、gVisor 和出网代理）", () => {
  const owner = `browser-${Math.random().toString(16).slice(2, 10)}`;
  let root = "";
  let manager: UserComputerManager;
  let closeServer = async () => {};
  let client: UserComputerClient;
  let browser: ProductionBrowserTools;
  const authorized: string[][] = [];

  const use = (toolCallId: string, args: Record<string, unknown>, modelRef = "text-only") =>
    browser.run(
      {
        runId: "run-browser-qualification",
        toolCallId,
        capabilityRef: BROWSER_CAPABILITY_REF,
        capabilityHandleRef: null,
        arguments: args,
        dataClassification: "private",
        executionDeadlineAt: new Date(Date.now() + 120_000).toISOString(),
        context: { threadId: "thread-browser-qualification", modelRef },
      } as never,
      {
        authorizeSites: async (sites) => {
          authorized.push([...sites]);
        },
        markExternalContent: async () => {},
      },
    );

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "himawari-computer-browser-"));
    const socketPath = path.join(root, "computers.sock");
    const configuration = parseUserComputerConfig({
      schemaVersion: "user-computers.v1",
      docker: { executable: dockerExecutable, host: null },
      runtime,
      image: { reference: null, digest: toolsImage },
      stateDirectory: path.join(root, "state"),
      socket: { path: socketPath, groupId: null },
      disk: { mode: "loop", sizeBytes: 512 * 1024 * 1024 },
      resources: { memoryBytes: 1024 * 1024 * 1024, cpus: 1, maxProcesses: 256 },
      admission: { startBytes: 64 * 1024 * 1024, reserveBytes: 0, waitMs: 1000, pollMs: 250 },
      idle: { stopAfterMs: 1, checkIntervalMs: 3_600_000, staleAfterMs: 30 * 86_400_000 },
      commandTimeoutMs: 120_000,
      stopGraceSeconds: 1,
      beforeStop: { argv: ["himawari-browser", "stop"], timeoutSeconds: 20 },
      hostPaths: { runtimeRoots: [RUNTIME_ROOT], seedRoots: [path.join(root, "seeds")] },
    });
    manager = new UserComputerManager(configuration);
    const server = await serveUserComputers(manager, socketPath);
    closeServer = () => new Promise((resolve) => server.close(() => resolve()));
    client = new UserComputerClient(socketPath);
    browser = new ProductionBrowserTools({
      ownerId: owner,
      computer: client,
      maxOutputBytes: 8 * 1024 * 1024,
      maxTextChars: 20_000,
      responseReserveMs: 5_000,
      acceptsImages: (modelRef) => modelRef === "sees-images",
      now: () => Date.now(),
    });
  }, 120_000);

  afterAll(async () => {
    await manager.deleteComputer(owner).catch(() => undefined);
    await closeServer();
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }, 120_000);

  it("正向：打开允许的网站、读到正文、截图交给能看图的模型", async () => {
    const opened = await use("open", { action: "open", url: "https://example.com/" });
    expect(authorized.at(-1)).toEqual(["example.com"]);
    const page = opened.value as { page: { title: string }; text: string };
    expect(page.page.title).toBe("Example Domain");
    expect(page.text).toContain("documentation examples");
    const shot = await use("shot", { action: "screenshot" }, "sees-images");
    expect(shot.images?.[0]?.mimeType).toBe("image/png");
    expect(shot.images?.[0]?.data.length ?? 0).toBeGreaterThan(1000);
  }, 300_000);

  it("反向：点去没放行的网站，电脑的出网代理拦下，工具说出是哪个网站", async () => {
    const read = await use("read", { action: "read" });
    const link = /\[((?:f\d+)?e\d+) link /u.exec((read.value as { text: string }).text)?.[1];
    expect(link).toBeDefined();
    const clicked = use("click", { action: "click", ref: link });
    await expect(clicked).rejects.toBeInstanceOf(BrowserToolError);
    await clicked.catch((error: BrowserToolError) => {
      expect(error.code).toBe("BROWSER_SITE_NOT_ALLOWED");
      expect(error.note).toMatch(/iana\.org/u);
    });
  }, 300_000);

  it("关机前把浏览器收好，网站数据留在主人自己的磁盘上", async () => {
    expect(await manager.stopIdle()).toHaveLength(1);
    const listed = await client.exec({
      ownerId: owner,
      argv: ["sh", "-c", "ls ~/.himawari/browser/profile/Default"],
      allowedDomains: [],
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      maxOutputBytes: 64 * 1024,
    });
    expect(listed.exitCode).toBe(0);
    expect(decode(listed.stdout)).toContain("Preferences");
    const again = await use("again", { action: "read" });
    expect((again.value as { page: { url: string } }).page.url).toBe("about:blank");
  }, 300_000);
});
