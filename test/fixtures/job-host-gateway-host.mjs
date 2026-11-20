import { fork } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const [gatewaySource, socketPath, idleExitMs] = process.argv.slice(2);
const { serveJobHostGateway } = await import(gatewaySource);
const child = fileURLToPath(new URL("./job-host-gateway-child.mjs", import.meta.url));
const server = createServer();
serveJobHostGateway(server, {
  idleExitMs: Number(idleExitMs),
  onIdle: () => server.close(),
  fork: () =>
    fork(child, [], { detached: true, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] }),
});
server.listen(socketPath, () => process.stdout.write("listening\n"));
