import { createServer, type Server } from "node:net";
import {
  type EncodedExecResult,
  type ExecRequest,
  type Reply,
  readLine,
  type SeedRequest,
} from "./client.ts";
import {
  UserComputerError,
  type UserComputerSeedInput,
  type UserComputerSeedResult,
  type UserComputers,
  type UserComputerWorkspaces,
} from "./types.ts";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

async function answer(
  computers: UserComputers & UserComputerWorkspaces,
  input: unknown,
): Promise<EncodedExecResult | UserComputerSeedResult> {
  if (!input || typeof input !== "object") throw new UserComputerError("COMPUTER_REQUEST_INVALID");
  const request = input as Partial<ExecRequest | SeedRequest>;
  if (!request.params || typeof request.params !== "object")
    throw new UserComputerError("COMPUTER_REQUEST_INVALID", "params");
  if (request.method === "seed") {
    const { ownerId, source } = request.params as Partial<UserComputerSeedInput>;
    if (typeof ownerId !== "string" || typeof source !== "string")
      throw new UserComputerError("COMPUTER_REQUEST_INVALID", "params");
    return computers.seedWorkspace({ ownerId, source });
  }
  if (request.method !== "exec") throw new UserComputerError("COMPUTER_REQUEST_INVALID", "method");
  const { stdin, ...rest } = request.params as ExecRequest["params"];
  if (stdin !== undefined && typeof stdin !== "string")
    throw new UserComputerError("COMPUTER_REQUEST_INVALID", "stdin");
  const result = await computers.exec({
    ...rest,
    ...(stdin === undefined ? {} : { stdin: new Uint8Array(Buffer.from(stdin, "base64")) }),
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("base64"),
    stderr: Buffer.from(result.stderr).toString("base64"),
    truncated: result.truncated,
  };
}

export function serveUserComputers(
  computers: UserComputers & UserComputerWorkspaces,
  socketPath: string,
): Promise<Server> {
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    void (async () => {
      let reply: Reply;
      try {
        const result = await answer(
          computers,
          JSON.parse(await readLine(socket, MAX_REQUEST_BYTES)),
        );
        reply = { ok: true, result };
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
