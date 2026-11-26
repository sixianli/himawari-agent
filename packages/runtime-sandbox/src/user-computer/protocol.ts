import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
  USER_COMPUTER_ERROR_CODES,
  type UserComputerErrorCode,
  type UserComputerExecInput,
  type UserComputerExecResult,
  UserComputerError,
  type UserComputers,
} from "./types.ts";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

interface ExecRequest {
  readonly method: "exec";
  readonly params: Omit<UserComputerExecInput, "stdin"> & { readonly stdin?: string };
}

type Reply =
  | {
      readonly ok: true;
      readonly result: {
        readonly exitCode: number;
        readonly stdout: string;
        readonly stderr: string;
        readonly truncated: boolean;
      };
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: UserComputerErrorCode; readonly detail: string };
    };

function readLine(socket: Socket, limit: number): Promise<string> {
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

function decodeExec(input: unknown): UserComputerExecInput {
  if (!input || typeof input !== "object") throw new UserComputerError("COMPUTER_REQUEST_INVALID");
  const request = input as Partial<ExecRequest>;
  if (request.method !== "exec" || !request.params || typeof request.params !== "object")
    throw new UserComputerError("COMPUTER_REQUEST_INVALID", "method");
  const { stdin, ...rest } = request.params;
  if (stdin !== undefined && typeof stdin !== "string")
    throw new UserComputerError("COMPUTER_REQUEST_INVALID", "stdin");
  return {
    ...rest,
    ...(stdin === undefined ? {} : { stdin: new Uint8Array(Buffer.from(stdin, "base64")) }),
  };
}

export function serveUserComputers(computers: UserComputers, socketPath: string): Promise<Server> {
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    void (async () => {
      let reply: Reply;
      try {
        const input = decodeExec(JSON.parse(await readLine(socket, MAX_REQUEST_BYTES)));
        const result = await computers.exec(input);
        reply = {
          ok: true,
          result: {
            exitCode: result.exitCode,
            stdout: Buffer.from(result.stdout).toString("base64"),
            stderr: Buffer.from(result.stderr).toString("base64"),
            truncated: result.truncated,
          },
        };
      } catch (error) {
        reply = {
          ok: false,
          error:
            error instanceof UserComputerError
              ? { code: error.code, detail: error.detail }
              : {
                  code: "COMPUTER_UNAVAILABLE",
                  detail: error instanceof Error ? error.message : String(error),
                },
        };
      }
      if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`);
    })();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

export class UserComputerClient implements UserComputers {
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  exec(input: UserComputerExecInput): Promise<UserComputerExecResult> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      socket.once("error", (error) =>
        reject(new UserComputerError("COMPUTER_UNAVAILABLE", error.message)),
      );
      socket.once("connect", () => {
        const { stdin, ...rest } = input;
        const request: ExecRequest = {
          method: "exec",
          params: {
            ...rest,
            ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin).toString("base64") }),
          },
        };
        socket.write(`${JSON.stringify(request)}\n`);
        readLine(socket, Number.MAX_SAFE_INTEGER)
          .then((line) => {
            socket.destroy();
            const reply = JSON.parse(line) as Reply;
            if (reply.ok) {
              resolve({
                exitCode: reply.result.exitCode,
                stdout: new Uint8Array(Buffer.from(reply.result.stdout, "base64")),
                stderr: new Uint8Array(Buffer.from(reply.result.stderr, "base64")),
                truncated: reply.result.truncated,
              });
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
