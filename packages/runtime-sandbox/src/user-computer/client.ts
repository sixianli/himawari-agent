import { createConnection, type Socket } from "node:net";
import {
  USER_COMPUTER_ERROR_CODES,
  UserComputerError,
  type UserComputerErrorCode,
  type UserComputerExecInput,
  type UserComputerExecResult,
  type UserComputerSeedInput,
  type UserComputerSeedResult,
  type UserComputers,
  type UserComputerWorkspaces,
} from "./types.ts";

export {
  COMPUTER_HOME,
  COMPUTER_RUNTIME,
  COMPUTER_WORKSPACE,
  UserComputerError,
  type UserComputerErrorCode,
  type UserComputerExecInput,
  type UserComputerExecResult,
  type UserComputerSeedInput,
  type UserComputerSeedResult,
  type UserComputers,
  type UserComputerWorkspaces,
} from "./types.ts";

export interface ExecRequest {
  readonly method: "exec";
  readonly params: Omit<UserComputerExecInput, "stdin"> & { readonly stdin?: string };
}

export interface SeedRequest {
  readonly method: "seed";
  readonly params: UserComputerSeedInput;
}

export interface EncodedExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export type Reply =
  | { readonly ok: true; readonly result: EncodedExecResult | UserComputerSeedResult }
  | {
      readonly ok: false;
      readonly error: { readonly code: UserComputerErrorCode; readonly detail: string };
    };

export function readLine(socket: Socket, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      const part = newline === -1 ? chunk : chunk.subarray(0, newline);
      size += part.length;
      if (size > limit) {
        cleanup();
        reject(new Error("COMPUTER_MESSAGE_TOO_LARGE"));
        return;
      }
      chunks.push(part);
      if (newline !== -1) {
        cleanup();
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("COMPUTER_CONNECTION_CLOSED"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
  });
}

export class UserComputerClient implements UserComputers, UserComputerWorkspaces {
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async exec(input: UserComputerExecInput): Promise<UserComputerExecResult> {
    const { stdin, ...rest } = input;
    const result = (await this.call({
      method: "exec",
      params: {
        ...rest,
        ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin).toString("base64") }),
      },
    })) as EncodedExecResult;
    return {
      exitCode: result.exitCode,
      stdout: new Uint8Array(Buffer.from(result.stdout, "base64")),
      stderr: new Uint8Array(Buffer.from(result.stderr, "base64")),
      truncated: result.truncated,
    };
  }

  async seedWorkspace(input: UserComputerSeedInput): Promise<UserComputerSeedResult> {
    return (await this.call({ method: "seed", params: input })) as UserComputerSeedResult;
  }

  private call(
    request: ExecRequest | SeedRequest,
  ): Promise<EncodedExecResult | UserComputerSeedResult> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      socket.once("error", (error) =>
        reject(new UserComputerError("COMPUTER_UNAVAILABLE", error.message)),
      );
      socket.once("connect", () => {
        socket.write(`${JSON.stringify(request)}\n`);
        readLine(socket, Number.MAX_SAFE_INTEGER)
          .then((line) => {
            socket.destroy();
            const reply = JSON.parse(line) as Reply;
            if (reply.ok) {
              resolve(reply.result);
              return;
            }
            const code = USER_COMPUTER_ERROR_CODES.includes(reply.error.code)
              ? reply.error.code
              : "COMPUTER_UNAVAILABLE";
            reject(new UserComputerError(code, reply.error.detail));
          })
          .catch((error: unknown) => {
            socket.destroy();
            reject(
              new UserComputerError(
                "COMPUTER_UNAVAILABLE",
                error instanceof Error ? error.message : String(error),
              ),
            );
          });
      });
    });
  }
}
