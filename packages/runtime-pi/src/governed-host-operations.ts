import type {
  BashOperations,
  EditOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { GovernedCodingOperationsPort } from "@himawari-agent/application/runtime-port";
import type { GovernedPiCodingToolOperations } from "./governed-coding-tools.js";

function timeoutMilliseconds(seconds: number | undefined): number | undefined {
  if (seconds === undefined) return undefined;
  // Pi validates this in its local BashOperations, which governed I/O replaces.
  const milliseconds = seconds * 1000;
  if (!Number.isFinite(seconds) || seconds <= 0 || milliseconds > 2_147_483_647) {
    throw new Error("PI_GOVERNED_INVALID_TIMEOUT_SECONDS");
  }
  return milliseconds;
}

function piCommandError(error: unknown, timeoutSeconds: number | undefined): unknown {
  if (!(error instanceof Error)) return error;
  if (error.message === "PI_COMMAND_TIMEOUT" && timeoutSeconds !== undefined)
    return new Error(`timeout:${timeoutSeconds}`);
  if (error.message === "PI_COMMAND_ABORTED") return new Error("aborted");
  return error;
}

export function createPiOperationsFromGovernedHostPort(
  port: GovernedCodingOperationsPort,
): Pick<GovernedPiCodingToolOperations, "read" | "write" | "edit" | "bash"> {
  const read: ReadOperations = {
    async access(absolutePath) {
      await port.access(absolutePath, "read");
    },
    async readFile(absolutePath) {
      return Buffer.from(await port.readFile(absolutePath));
    },
  };
  const write: WriteOperations = {
    writeFile: (absolutePath, content) => port.writeFile(absolutePath, content),
    mkdir: (absolutePath) => port.makeDirectory(absolutePath),
  };
  const edit: EditOperations = {
    ...read,
    async access(absolutePath) {
      await port.access(absolutePath, "write");
    },
    writeFile: (absolutePath, content) => port.writeFile(absolutePath, content),
  };
  const bash: BashOperations = {
    exec: async (command, cwd, options) => {
      const timeoutMs = timeoutMilliseconds(options.timeout);
      try {
        return await port.executeCommand({
          command,
          cwd,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(options.env ? { environment: options.env } : {}),
          onData: (data) => options.onData(Buffer.from(data)),
        });
      } catch (error) {
        throw piCommandError(error, options.timeout);
      }
    },
  };
  return Object.freeze({ read, write, edit, bash });
}
