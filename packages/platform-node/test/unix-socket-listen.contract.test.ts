import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTHENTICATED_UDS_ERROR_CODES,
  assertUnixSocketPathLength,
  maximumUnixSocketPathBytes,
  prepareUnixSocketPath,
  removeUnixSocketFile,
  sealUnixSocket,
} from "../src/index.js";

const roots: string[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "himawari-unix-"));
  roots.push(directory);
  return directory;
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

describe("[MU-A] unix socket listening helpers shared by the web service", () => {
  it("creates the directory as 0700 and seals the socket file as 0600", async () => {
    const socketPath = path.join(await root(), "tenant", "web.sock");
    await prepareUnixSocketPath(socketPath);
    expect((await stat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
    const server = http.createServer((_request, response) => response.end("ok"));
    servers.push(server);
    await listen(server, socketPath);
    const identity = await sealUnixSocket(socketPath);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect(identity.ino).toBe((await stat(socketPath)).ino);
  });

  it("rejects a path longer than the platform limit before binding anything", async () => {
    const limit = maximumUnixSocketPathBytes();
    const tooLong = path.join(await root(), "x".repeat(limit));
    expect(() => assertUnixSocketPathLength(tooLong)).toThrow(/exceeds/u);
    await expect(prepareUnixSocketPath(tooLong)).rejects.toThrow(/exceeds/u);
    expect(() => assertUnixSocketPathLength("/tmp/ok.sock")).not.toThrow();
  });

  it("removes a stale socket file left by a killed process but refuses a live one", async () => {
    const socketPath = path.join(await root(), "web.sock");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => console.log("up"));setInterval(()=>{},1000)`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise((resolve) => child.stdout.once("data", resolve));
    await expect(prepareUnixSocketPath(socketPath)).rejects.toMatchObject({
      message: AUTHENTICATED_UDS_ERROR_CODES.SOCKET_EXISTS,
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    expect((await lstat(socketPath)).isSocket()).toBe(true);
    await prepareUnixSocketPath(socketPath);
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to replace a regular file at the socket path", async () => {
    const directory = await root();
    const socketPath = path.join(directory, "web.sock");
    await writeFile(socketPath, "not a socket");
    await expect(prepareUnixSocketPath(socketPath)).rejects.toMatchObject({
      message: AUTHENTICATED_UDS_ERROR_CODES.SOCKET_EXISTS,
    });
  });

  it("treats a missing file as already removed", async () => {
    await expect(
      removeUnixSocketFile(path.join(await root(), "gone.sock")),
    ).resolves.toBeUndefined();
  });
});
