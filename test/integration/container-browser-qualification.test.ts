import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdtemp } from "node:fs/promises";
import path from "node:path";
import type { ExecutionEnvironmentLocator } from "@himawari-agent/execution-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ContainerQualification,
  direct,
  dockerHost,
  EGRESS_IMAGE_DIGEST,
  EGRESS_IMAGE_REFERENCE,
  grant,
  type QualificationBackend,
  type QualificationTarget,
  stopAndProve,
} from "./container-qualification-support.ts";

const enabled = process.env["HIMAWARI_CONTAINER_BROWSER_QUALIFICATION"] === "1";
const browserImageId = process.env["HIMAWARI_CONTAINER_BROWSER_IMAGE_ID"] ?? "";
const browserDescribe = enabled ? describe : describe.skip;
const qualification = new ContainerQualification();
const fixtures = path.join(import.meta.dirname, "fixtures", "browser-image");
const BROWSER_RESOURCES = {
  cpuMillicores: 1000,
  memoryBytes: 1024 * 1024 * 1024,
  maxProcesses: 512,
  privateStorageBytes: 512 * 1024 * 1024,
};

async function fixtureDirectory(name: string, file: string) {
  const directory = await mkdtemp(path.join(qualification.hostRoot, `${name}-`));
  await chmod(directory, 0o755);
  await copyFile(path.join(fixtures, file), path.join(directory, file));
  await chmod(path.join(directory, file), 0o644);
  return directory;
}

async function approveDirectory(canonicalRootId: string, directory: string) {
  const info = await lstat(directory);
  qualification.approved.set(canonicalRootId, {
    canonicalPath: directory,
    device: String(info.dev),
    inode: String(info.ino),
  });
}

function browserEnvironment() {
  const target = qualification.environment(
    1800,
    [grant("browser-driver", "read")],
    ["example.com:443"],
  );
  return {
    ...target,
    create: {
      ...target.create,
      imageDigest: browserImageId,
      envelope: { ...target.create.envelope, resources: BROWSER_RESOURCES },
    },
  };
}

async function execute(
  subject: QualificationBackend,
  target: QualificationTarget,
  locator: ExecutionEnvironmentLocator,
  argv: string[],
) {
  const ref = `arguments-${randomUUID()}`;
  qualification.argumentsByRef.set(ref, { argv });
  const { outputRef } = await subject.execute({
    identity: target.identity,
    createIntentId: target.createIntentId,
    locator,
    stopFence: 0,
    invocationId: `invocation-${randomUUID()}`,
    argumentsRef: ref,
    authorizationRef: "authorization-q",
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
  });
  return subject.readOutput(outputRef);
}

async function inspect(nameOrId: string) {
  return JSON.parse(
    (await direct("container", "inspect", "--format", "{{json .}}", nameOrId)).stdout,
  );
}

function driverResult(stdout: string) {
  const line = stdout.split("\n").find((item) => item.startsWith("result="));
  return JSON.parse(line?.slice("result=".length) ?? "null");
}

browserDescribe("a real browser inside a container environment", () => {
  beforeAll(async () => {
    await qualification.setup();
  });
  afterAll(async () => {
    if (enabled) await qualification.cleanup();
  });

  it(
    "keeps the browser, its profile, downloads and egress inside the environment and ends them with it",
    { timeout: 10 * 60_000 },
    async () => {
      expect(browserImageId, "HIMAWARI_CONTAINER_BROWSER_IMAGE_ID").toMatch(/^[a-f0-9]{64}$/);
      await approveDirectory("browser-driver", await fixtureDirectory("driver", "driver.mjs"));
      const siteDirectory = await fixtureDirectory("site", "site.mjs");
      const subject = qualification.backend(dockerHost, {
        image: { reference: "himawari/browser-fixture", digest: browserImageId, pin: "image-id" },
      });
      const first = browserEnvironment();
      const firstLocator = await subject.create(first.create);
      const firstNetwork = String(
        (await inspect(firstLocator.runtimeEnvironmentId)).HostConfig.NetworkMode,
      );
      const site = `himawari-q-site-${qualification.runId}`;
      const started = await direct(
        "container",
        "run",
        "--detach",
        "--name",
        site,
        "--label",
        `io.himawari.environment.run=${qualification.runId}`,
        "--network",
        firstNetwork,
        "--network-alias",
        "site.test",
        "--user",
        "65533:65533",
        "--read-only",
        "--mount",
        `type=bind,source=${siteDirectory},target=/site,readonly`,
        `${EGRESS_IMAGE_REFERENCE}@sha256:${EGRESS_IMAGE_DIGEST}`,
        "node",
        "/site/site.mjs",
      );
      expect(started.exitCode, started.stderr).toBe(0);
      const siteNode = async (script: string) =>
        (await direct("container", "exec", site, "node", "-e", script)).stdout.trim();
      const downloadedBytes = async () =>
        Number(
          await siteNode(
            "fetch('http://127.0.0.1:8080/bytes').then((r) => r.text()).then(console.log, () => console.log(-1))",
          ),
        );
      let ready = false;
      for (let attempt = 0; attempt < 50 && !ready; attempt++) {
        ready = (await downloadedBytes()) === 0;
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(ready).toBe(true);

      const full = await execute(subject, first, firstLocator, [
        "node",
        "/workspaces/browser-driver/driver.mjs",
        "full",
      ]);
      expect(full.exitCode, full.stderr).toBe(0);
      const result = driverResult(full.stdout);
      qualification.observations["browserDriver"] = result;
      expect(result.profileExistedBeforeLaunch).toBe(false);
      expect(result.setCookie.text).toBe("set|cookie set");
      expect(result.showCookie.text).toBe("show|cookie=himawari=fixture-cookie");
      expect(result.approved.text).toMatch(/^Example Domain\|/);
      expect(result.unapproved.error).toMatch(/^net::ERR_/);
      expect(result.downloadReceivedBytes).toBeGreaterThan(0);

      const processes = await execute(subject, first, firstLocator, [
        "sh",
        "-c",
        "ps -o comm= | grep -c chrom; node -e \"fetch('http://127.0.0.1:9222/json/version').then(() => console.log('cdp=local'), () => console.log('cdp=missing'))\"; nohup node -e \"require('node:net').createServer((socket) => socket.end()).listen(9333, '0.0.0.0')\" >/dev/null 2>&1 &",
      ]);
      const [browserProcesses, cdpInside] = processes.stdout.trim().split("\n");
      expect(Number(browserProcesses)).toBeGreaterThan(1);
      expect(cdpInside).toBe("cdp=local");
      const taskAddress = String(
        (await inspect(firstLocator.runtimeEnvironmentId)).NetworkSettings.Networks[firstNetwork]
          .IPAddress,
      );
      const fromNeighbour = (port: number) =>
        siteNode(
          `require('node:net').connect(${port}, '${taskAddress}').on('connect', () => { console.log('open'); process.exit(0); }).on('error', () => { console.log('closed'); process.exit(0); })`,
        );
      let controlFromNeighbour = "closed";
      for (let attempt = 0; attempt < 50 && controlFromNeighbour !== "open"; attempt++) {
        controlFromNeighbour = await fromNeighbour(9333);
        if (controlFromNeighbour !== "open")
          await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(controlFromNeighbour).toBe("open");
      const cdpFromNeighbour = await fromNeighbour(9222);
      expect(cdpFromNeighbour).toBe("closed");
      const published = (await inspect(firstLocator.runtimeEnvironmentId)).HostConfig.PortBindings;
      expect(published ?? {}).toEqual({});
      const beforeStop = await downloadedBytes();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const stillDownloading = await downloadedBytes();
      expect(stillDownloading).toBeGreaterThan(beforeStop);

      const firstProof = await stopAndProve(subject, first, firstLocator);
      expect(firstProof.basis).toBe("verified_stopped");
      const siteLog = (await direct("container", "logs", site)).stdout;
      expect(siteLog).toContain("download-closed");
      const afterStop = await downloadedBytes();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(await downloadedBytes()).toBe(afterStop);

      const second = browserEnvironment();
      const secondLocator = await subject.create(second.create);
      const secondNetwork = String(
        (await inspect(secondLocator.runtimeEnvironmentId)).HostConfig.NetworkMode,
      );
      const connected = await direct(
        "network",
        "connect",
        "--alias",
        "site.test",
        secondNetwork,
        site,
      );
      expect(connected.exitCode, connected.stderr).toBe(0);
      const probe = await execute(subject, second, secondLocator, [
        "node",
        "/workspaces/browser-driver/driver.mjs",
        "probe",
      ]);
      expect(probe.exitCode, probe.stderr).toBe(0);
      const fresh = driverResult(probe.stdout);
      expect(fresh.profileExistedBeforeLaunch).toBe(false);
      expect(fresh.showCookie.text).toBe("show|cookie=none");
      expect((await stopAndProve(subject, second, secondLocator)).basis).toBe("verified_stopped");
      await direct("container", "rm", "--force", site);

      qualification.observations["browser"] = {
        imageId: browserImageId,
        firstEnvironment: result,
        browserProcesses: Number(browserProcesses),
        cdpInside,
        controlFromNeighbour,
        cdpFromNeighbour,
        publishedPorts: published ?? {},
        downloadBytes: { beforeStop, stillDownloading, afterStop },
        siteLog: siteLog.trim().split("\n"),
        secondEnvironment: fresh,
      };
    },
  );
});
