import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import process from "node:process";

const [guardianUrl, groupUrl, readyPath, cleanupTimeout] = process.argv.slice(2);
const moduleStarted = performance.now();
const { startLinuxHostGuardian } = await import(guardianUrl);
const guardianModuleLoadMs = performance.now() - moduleStarted;
const { readLinuxHostGroup, readLinuxProcessIdentity } = await import(groupUrl);
const before = performance.now();
await startLinuxHostGuardian(Number(cleanupTimeout), () => process.exit(1));
const startupMs = performance.now() - before;
const proxy = spawn("/bin/sleep", ["120"], { stdio: "ignore", detached: false });
proxy.unref();
const hostIdentity = await readLinuxProcessIdentity(process.pid);
const proxyIdentity = await readLinuxProcessIdentity(proxy.pid);
const members = await readLinuxHostGroup(process.pid);
const guardians = members.filter(
  (item) => item.parentProcessId === process.pid && item.processId !== proxy.pid,
);
if (!hostIdentity || !proxyIdentity || guardians.length !== 1)
  throw new Error("GUARDIAN_FIXTURE_IDENTITY_MISSING");
const guardianIdentity = guardians[0];
const status = await readFile(`/proc/${guardianIdentity.processId}/status`, "utf8");
const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
if (!rss) throw new Error("GUARDIAN_FIXTURE_RSS_MISSING");
await writeFile(
  `${readyPath}.partial`,
  JSON.stringify({
    hostIdentity,
    proxyIdentity,
    guardianIdentity,
    startupMs,
    guardianModuleLoadMs,
    addedPreparationMs: startupMs + guardianModuleLoadMs,
    guardianRssBytes: Number(rss[1]) * 1024,
    nodeVersion: process.version,
    implementation: guardianUrl,
  }),
);
await rename(`${readyPath}.partial`, readyPath);
setInterval(() => {}, 1000);
