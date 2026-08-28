import type { GovernedCodingOperationsPort } from "@himawari-agent/application/runtime-port";
import type {
  BashOperations,
  EditOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { GovernedPiCodingToolOperations } from "./governed-coding-tools.js";

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
    exec: (command, cwd, options) =>
      port.executeCommand({
        command,
        cwd,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
        ...(options.env ? { environment: options.env } : {}),
        onData: (data) => options.onData(Buffer.from(data)),
      }),
  };
  return Object.freeze({ read, write, edit, bash });
}
