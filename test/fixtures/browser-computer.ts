import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import type {
  BrowserComputer,
  BrowserComputerExecInput,
  BrowserComputerExecResult,
} from "../../apps/agent-service/src/production-browser-tools.js";
import { openNetworkEgress } from "../../packages/runtime-sandbox/src/network-egress.ts";
import { PREINSTALLED_CHROMIUM } from "./chromium-launch.ts";
import { repositoryRoot } from "./product-path-harness.ts";

const PROGRAM = path.join(
  repositoryRoot,
  "packages/runtime-sandbox/computer-image/himawari-browser.mjs",
);

function chromiumEnv(): Record<string, string> {
  const browsers = {
    PLAYWRIGHT_BROWSERS_PATH:
      process.env["PLAYWRIGHT_BROWSERS_PATH"] || path.join(homedir(), ".cache", "ms-playwright"),
  };
  const configured = process.env["HIMAWARI_CHROMIUM_PATH"];
  const managed = chromium.executablePath();
  const executable =
    configured ||
    (existsSync(managed)
      ? managed
      : existsSync(PREINSTALLED_CHROMIUM)
        ? PREINSTALLED_CHROMIUM
        : "");
  return executable ? { ...browsers, HIMAWARI_BROWSER_EXECUTABLE: executable } : browsers;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export class ComputerOnThisMachine implements BrowserComputer {
  readonly calls: BrowserComputerExecInput[] = [];
  readonly home: string;
  readonly #port: number;
  readonly #token = "a".repeat(64);

  constructor(home: string, port: number) {
    this.home = home;
    this.#port = port;
  }

  run(argv: readonly string[], stdin: Uint8Array, deadlineAt: string) {
    const proxy = `http://job:${this.#token}@127.0.0.1:${this.#port}`;
    return new Promise<BrowserComputerExecResult>((resolve, reject) => {
      const child = spawn(process.execPath, [PROGRAM, ...argv], {
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: this.home,
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
          ...chromiumEnv(),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), Date.parse(deadlineAt) - Date.now());
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          truncated: false,
        });
      });
      child.stdin.end(stdin);
    });
  }

  async exec(input: BrowserComputerExecInput): Promise<BrowserComputerExecResult> {
    this.calls.push(input);
    const egress =
      input.allowedDomains.length > 0
        ? await openNetworkEgress(input.allowedDomains, async () => {}, {
            host: "127.0.0.1",
            port: this.#port,
            token: this.#token,
          })
        : null;
    try {
      const result = await this.run(
        input.argv.slice(1),
        input.stdin ?? new Uint8Array(),
        input.deadlineAt,
      );
      if (result.stdout.byteLength > input.maxOutputBytes)
        return {
          ...result,
          stdout: result.stdout.subarray(0, input.maxOutputBytes),
          truncated: true,
        };
      return result;
    } finally {
      await egress?.close();
    }
  }
}
