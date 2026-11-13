import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { type JobHostReadinessProbe, quoteJobArgument } from "./job-host-protocol.ts";

/** Fixed infrastructure probe. HTTP is confined to this job's one Unix socket,
 * with bounded headers/time and no response-body buffering or log interpretation. */
const program = `const http=require('node:http');
const [socketPath,url,status,deadline]=process.argv.slice(1);
let active, retry; const end=setTimeout(()=>finish(1),Math.max(1,Number(deadline)-Date.now()));
function finish(code){clearTimeout(end);clearTimeout(retry);active?.destroy();process.exit(code)}
function check(){
 active=http.request({socketPath,path:url,method:'GET',maxHeaderSize:4096,timeout:500},r=>{
  const ok=r.statusCode===Number(status);r.destroy();if(ok)finish(0);else again();
 });active.once('timeout',()=>active.destroy());active.once('error',again);active.end();
}
function again(){clearTimeout(retry);if(Date.now()>=Number(deadline))finish(1);else retry=setTimeout(check,100)}
check();`;
export function startReadinessProbe(options: {
  probe: JobHostReadinessProbe;
  privateDirectory: string;
  deadlineAt: string;
  wrap(command: string): Promise<{ argv: string[]; env?: NodeJS.ProcessEnv }>;
  active(): boolean;
}) {
  let child: ChildProcess | undefined;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Owned process only. */
      }
    }
  };
  const result = (async () => {
    const deadline = Math.min(Date.parse(options.deadlineAt), Date.now() + options.probe.timeoutMs);
    const args = [
      process.execPath,
      "-e",
      program,
      path.join(options.privateDirectory, options.probe.socketName),
      options.probe.path,
      String(options.probe.expectedStatus),
      String(deadline),
    ];
    const launch = await options.wrap(args.map(quoteJobArgument).join(" "));
    if (cancelled || !options.active() || Date.now() >= deadline) return false;
    const executable = launch.argv[0];
    if (!executable) throw new Error("READINESS_LAUNCH_INVALID");
    return new Promise<boolean>((resolve) => {
      child = spawn(executable, launch.argv.slice(1), {
        env: launch.env,
        cwd: options.privateDirectory,
        stdio: "ignore",
        detached: true,
        shell: false,
      });
      const timeout = setTimeout(cancel, Math.max(1, deadline - Date.now()));
      child.once("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve(!cancelled && options.active() && code === 0);
      });
    });
  })();
  return { cancel, result };
}
