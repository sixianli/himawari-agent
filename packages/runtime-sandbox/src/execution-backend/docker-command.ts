import { spawn } from "node:child_process";

export interface DockerCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export type DockerCommand = (
  args: readonly string[],
  options: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly environment?: Readonly<Record<string, string>>;
  },
) => Promise<DockerCommandResult>;

export class DockerCommandTimeout extends Error {
  constructor() {
    super("DOCKER_COMMAND_TIMEOUT");
    this.name = "DockerCommandTimeout";
  }
}

const REDIRECTING_VARIABLES = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
];

export function dockerCli(executable: string, globalArgs: readonly string[]): DockerCommand {
  return (args, { timeoutMs, maxOutputBytes, environment }) =>
    new Promise((resolve, reject) => {
      const env = { ...process.env, ...environment };
      for (const name of REDIRECTING_VARIABLES) delete env[name];
      const child = spawn(executable, [...globalArgs, ...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const streams = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      const sizes = { stdout: 0, stderr: 0 };
      let truncated = false;
      const collect = (name: "stdout" | "stderr") => (chunk: Buffer) => {
        const room = maxOutputBytes - sizes[name];
        if (chunk.length > room) truncated = true;
        if (room <= 0) return;
        const kept = chunk.subarray(0, room);
        streams[name].push(kept);
        sizes[name] += kept.length;
      };
      child.stdout.on("data", collect("stdout"));
      child.stderr.on("data", collect("stderr"));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new DockerCommandTimeout());
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(streams.stdout).toString("utf8"),
          stderr: Buffer.concat(streams.stderr).toString("utf8"),
          truncated,
        });
      });
    });
}
