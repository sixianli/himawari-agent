import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { safeRelativePath } from "./contracts.mjs";

export const REMOTE_SHARE_DIRECTORY = "/etc/gh-runner/remote-share";
export const REMOTE_LIMITS = Object.freeze({
  files: 500,
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  responseBytes: 96 * 1024 * 1024,
  connectSeconds: 15,
  totalMilliseconds: 120_000,
});

const TARGET = /^[a-z][a-z0-9-]{0,31}@[0-9A-Za-z][0-9A-Za-z.-]{0,252}$/u;
const RUN = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$/u;
const NAME = /^[a-z][a-z0-9-]{0,63}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SHARED_MODE = 0o2770;

const fail = (code) => {
  throw new Error(`CI_REMOTE_SHARE_${code}`);
};

export function remoteShareConfig(env) {
  const directory = env.HIMAWARI_CI_REMOTE_SHARE ?? REMOTE_SHARE_DIRECTORY;
  if (!path.isAbsolute(directory)) fail("DIRECTORY_INVALID");
  if (!existsSync(directory)) return undefined;
  const file = (name) => {
    const filename = path.join(directory, name);
    const info = lstatSync(filename, { throwIfNoEntry: false });
    if (!info?.isFile()) fail(`CONFIG_MISSING:${name}`);
    return filename;
  };
  const target = readFileSync(file("target"), "utf8").trim();
  if (!TARGET.test(target)) fail("TARGET_INVALID");
  return { target, identity: file("id_ed25519"), knownHosts: file("known_hosts") };
}

export function sshArguments(config, request, limits = REMOTE_LIMITS) {
  return [
    "-F",
    "none",
    "-T",
    "-i",
    config.identity,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${config.knownHosts}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    `ConnectTimeout=${limits.connectSeconds}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    config.target,
    request,
  ];
}

export function requestRemote({
  config,
  request,
  limits = REMOTE_LIMITS,
  command = "ssh",
  spawnProcess = spawn,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, sshArguments(config, request, limits), {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const settle = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action(value);
    };
    const stop = (code) => {
      child.kill("SIGKILL");
      child.stdout.destroy();
      settle(reject, new Error(`CI_REMOTE_SHARE_${code}`));
    };
    const timer = setTimeout(() => stop("TIMEOUT"), limits.totalMilliseconds);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limits.responseBytes) stop("RESPONSE_TOO_LARGE");
      else chunks.push(chunk);
    });
    child.on("error", () => settle(reject, new Error("CI_REMOTE_SHARE_SSH_UNAVAILABLE")));
    child.on("close", (status) =>
      settle(resolve, { status, body: Buffer.concat(chunks).toString("utf8") }),
    );
  });
}

export function parseRemoteReport({ status, body }, { run, name }, limits = REMOTE_LIMITS) {
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    fail(`RESPONSE_INVALID:status=${status}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("RESPONSE_INVALID");
  if (typeof value.error === "string" && /^[A-Z_]{1,40}$/u.test(value.error))
    fail(`REFUSED:${value.error}`);
  if (status !== 0) fail(`SSH_FAILED:status=${status}`);
  if (value.run !== run || value.name !== name) fail("RESPONSE_MISMATCH");
  if (!Array.isArray(value.files) || value.files.length === 0) fail("RESPONSE_EMPTY");
  if (value.files.length > limits.files) fail("TOO_MANY_FILES");
  const seen = new Set();
  let total = 0;
  return value.files.map((entry) => {
    if (entry === null || typeof entry !== "object") fail("ENTRY_INVALID");
    const { path: relative, data } = entry;
    if (typeof relative !== "string" || !safeRelativePath(relative)) fail("PATH_INVALID");
    const key = relative.toLowerCase();
    for (const other of seen)
      if (other === key || other.startsWith(`${key}/`) || key.startsWith(`${other}/`))
        fail("PATH_DUPLICATE");
    seen.add(key);
    if (typeof data !== "string" || !BASE64.test(data)) fail("DATA_INVALID");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > limits.fileBytes) fail("FILE_TOO_LARGE");
    total += bytes.length;
    if (total > limits.totalBytes) fail("TOTAL_TOO_LARGE");
    return { path: relative, bytes };
  });
}

export async function pullRemoteReport({ config, root, run, name, limits, command, spawnProcess }) {
  if (!RUN.test(run ?? "")) fail("RUN_INVALID");
  if (!NAME.test(name ?? "")) fail("NAME_INVALID");
  const runDirectory = path.join(root, run);
  const target = path.join(runDirectory, name);
  if (existsSync(target)) fail("ALREADY_PRESENT");
  const response = await requestRemote({
    config,
    request: `${run}/${name}`,
    limits,
    command,
    spawnProcess,
  });
  const files = parseRemoteReport(response, { run, name }, limits);
  mkdirSync(runDirectory, { recursive: true });
  const staging = path.join(runDirectory, `.remote-${name}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    mkdirSync(staging);
    chmodSync(staging, SHARED_MODE);
    for (const file of files) {
      const filename = path.join(staging, file.path);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, file.bytes, { flag: "wx", mode: 0o660 });
    }
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return files.length;
}
