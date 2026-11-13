import { createServer } from "node:net";
import { parseJobHostGatewayArgs, serveJobHostGateway } from "./job-host-gateway.ts";

const args = parseJobHostGatewayArgs(process.argv.slice(2), process.env, process.pid);
const server = createServer();
serveJobHostGateway(server, {
  idleExitMs: args.idleExitMs,
  onIdle: () => {
    server.close();
    process.exitCode = 0;
  },
});
server.on("error", () => {
  process.exitCode = 1;
  server.close();
});
server.listen(args.listen);
