import { chmod, chown, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { readUserComputerConfig } from "./config.ts";
import { UserComputerManager } from "./manager.ts";
import { serveUserComputers } from "./protocol.ts";

const configIndex = process.argv.indexOf("--config");
const configPath = configIndex === -1 ? undefined : process.argv[configIndex + 1];
if (!configPath) {
  process.stderr.write("usage: user-computer-host --config <file>\n");
  process.exit(64);
}

const config = await readUserComputerConfig(configPath);
await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
const socketDirectory = path.dirname(config.socket.path);
await mkdir(socketDirectory, { recursive: true, mode: 0o750 });
if (config.socket.groupId !== null) await chown(socketDirectory, 0, config.socket.groupId);
await chmod(socketDirectory, config.socket.groupId === null ? 0o700 : 0o750);
await rm(config.socket.path, { force: true });

const manager = new UserComputerManager(config);
const server = await serveUserComputers(manager, config.socket.path);
if (config.socket.groupId !== null) await chown(config.socket.path, 0, config.socket.groupId);
await chmod(config.socket.path, config.socket.groupId === null ? 0o600 : 0o660);
manager.start();
process.stdout.write(`USER_COMPUTER_HOST_READY ${config.socket.path}\n`);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close();
  void manager.close().finally(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
