import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectArtifactFiles } from "./artifact-files.mjs";
import { parseArguments, sha256 } from "./contracts.mjs";

const NAME = /^[a-z][a-z0-9-]{0,63}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const SHARED_MODE = 0o2770;
const SHARED_UMASK = 0o007;

const fail = (code) => {
  throw new Error(`CI_SHARE_${code}`);
};

export function shareRoot(env) {
  const root = env.HIMAWARI_CI_SHARE;
  if (!root || !path.isAbsolute(root)) fail("ROOT_REQUIRED");
  const info = lstatSync(root, { throwIfNoEntry: false });
  if (!info?.isDirectory() || info.isSymbolicLink()) fail("ROOT_INVALID");
  return root;
}

export function runName(env) {
  if (!/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID ?? "")) fail("RUN_ID_INVALID");
  if (!/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT ?? "")) fail("RUN_ATTEMPT_INVALID");
  return `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
}

const sharedDirectory = (directory) => {
  mkdirSync(directory, { recursive: true });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("DIRECTORY_INVALID");
  if ((info.mode & 0o7777) === SHARED_MODE) return;
  if (info.uid !== process.getuid()) fail("DIRECTORY_MODE");
  chmodSync(directory, SHARED_MODE);
};

const shareGroupWritable = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      chmodSync(filename, SHARED_MODE);
      shareGroupWritable(filename);
    } else chmodSync(filename, 0o660);
  }
};

export async function treeDigest(directory) {
  const files = await collectArtifactFiles(directory);
  if (files.length === 0) fail("EMPTY");
  return sha256(
    JSON.stringify(files.map(({ path: name, sha256: hash, bytes }) => [name, hash, bytes])),
  );
}

const checkedName = (name) => {
  if (!NAME.test(name ?? "")) fail("NAME_INVALID");
  return name;
};

export async function put({ root, run, name, from }) {
  checkedName(name);
  const digest = await treeDigest(from);
  const runDirectory = path.join(root, run);
  sharedDirectory(runDirectory);
  const target = path.join(runDirectory, name);
  if (existsSync(target)) fail("ALREADY_PUBLISHED");
  const staging = path.join(runDirectory, `.staging-${name}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  cpSync(from, staging, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
  chmodSync(staging, SHARED_MODE);
  shareGroupWritable(staging);
  if ((await treeDigest(staging)) !== digest) {
    rmSync(staging, { recursive: true, force: true });
    fail("COPY_CHANGED");
  }
  renameSync(staging, target);
  return digest;
}

export async function get({ root, run, name, digest, to }) {
  checkedName(name);
  if (!DIGEST.test(digest ?? "")) fail("DIGEST_INVALID");
  const source = path.join(root, run, name);
  const info = lstatSync(source, { throwIfNoEntry: false });
  if (!info?.isDirectory() || info.isSymbolicLink()) fail(`MISSING:${name}`);
  if (existsSync(to)) fail("DESTINATION_EXISTS");
  mkdirSync(path.dirname(to), { recursive: true });
  let copied;
  try {
    cpSync(source, to, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
    copied = await treeDigest(to);
  } catch (error) {
    rmSync(to, { recursive: true, force: true });
    throw error;
  }
  if (copied !== digest) {
    rmSync(to, { recursive: true, force: true });
    fail(`DIGEST_MISMATCH:${name}`);
  }
}

export function publishedMembers(needs) {
  const members = [];
  for (const [job, entry] of Object.entries(needs ?? {}).sort(([a], [b]) => a.localeCompare(b)))
    for (const [member, digest] of Object.entries(entry?.outputs ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ))
      if (DIGEST.test(digest)) members.push({ job, name: checkedName(`${job}-${member}`), digest });
  return members;
}

export async function collect({ root, run, needs, to }) {
  const members = publishedMembers(needs);
  const missing = [];
  for (const { name, digest } of members) {
    try {
      await get({ root, run, name, digest, to: path.join(to, name) });
    } catch (error) {
      missing.push(error.message);
    }
  }
  mkdirSync(to, { recursive: true });
  return { collected: members.length - missing.length, missing };
}

export function remove({ root, run }) {
  rmSync(path.join(root, run), { recursive: true, force: true });
}

async function dispatch(argv, env) {
  const [command, ...rest] = argv;
  const args = parseArguments(rest, ["--name", "--from", "--to", "--digest", "--output-key"]);
  const root = shareRoot(env);
  const run = runName(env);
  if (command === "put") {
    if (!args["--from"] || !/^[a-z][a-z0-9-]*$/u.test(args["--output-key"] ?? ""))
      fail("PUT_INPUT_REQUIRED");
    if (!env.GITHUB_OUTPUT) fail("GITHUB_OUTPUT_REQUIRED");
    const digest = await put({ root, run, name: args["--name"], from: args["--from"] });
    appendFileSync(env.GITHUB_OUTPUT, `${args["--output-key"]}=${digest}\n`);
    return `CI_SHARE_PUT ${args["--name"]} ${digest}`;
  }
  if (command === "get") {
    if (!args["--to"]) fail("GET_INPUT_REQUIRED");
    await get({ root, run, name: args["--name"], digest: args["--digest"], to: args["--to"] });
    return `CI_SHARE_GET ${args["--name"]} ${args["--digest"]}`;
  }
  if (command === "collect") {
    if (!args["--to"] || !env.CI_NEEDS) fail("COLLECT_INPUT_REQUIRED");
    const result = await collect({
      root,
      run,
      needs: JSON.parse(env.CI_NEEDS),
      to: args["--to"],
    });
    for (const reason of result.missing)
      process.stderr.write(`CI_SHARE_COLLECT_MISSING ${reason}\n`);
    return [`CI_SHARE_COLLECT ${result.collected}`, ...result.missing].join("\n");
  }
  if (command === "remove") {
    remove({ root, run });
    return `CI_SHARE_REMOVED ${run}`;
  }
  fail("COMMAND_INVALID");
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const previous = process.umask(SHARED_UMASK);
  try {
    return await dispatch(argv, env);
  } finally {
    process.umask(previous);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${await main()}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
