import { lstatSync, realpathSync } from "node:fs";

const UNEXPECTED = "JOB_HOST_LAUNCH_ARGV_UNEXPECTED";
const ARGUMENT_FILE = "JOB_HOST_LAUNCH_ARGV_FILE_UNSUPPORTED";
const HELPER_NOT_IN_USE = "JOB_HOST_SECCOMP_HELPER_NOT_IN_USE";
const NESTED_USERNS_DENIED = "SRT_ALLOW_NESTED_USERNS=0";
const BARE = /^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/;
const QUOTE_ESCAPE = `'"'"'`;
const ZERO_ARGUMENT_OPTIONS = new Set([
  "--new-session",
  "--die-with-parent",
  "--unshare-net",
  "--unshare-pid",
  "--unshare-user",
]);
const ONE_ARGUMENT_OPTIONS = new Set(["--tmpfs", "--dev", "--proc", "--unsetenv", "--cap-drop"]);
const TWO_ARGUMENT_OPTIONS = new Set(["--bind", "--ro-bind", "--setenv"]);

function unexpected(): never {
  throw new Error(UNEXPECTED);
}

function covers(parent: string, child: string): boolean {
  if (parent === child) return true;
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(prefix);
}

export function resolveLinuxTmpfsDestination(directory: string): string {
  try {
    if (!lstatSync(directory).isSymbolicLink()) return directory;
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

function quoteArg(arg: string): string {
  if (arg === "") return "''";
  if (BARE.test(arg)) return arg;
  return `'${arg.replaceAll("'", QUOTE_ESCAPE)}'`;
}

function quote(args: readonly string[]): string {
  return args.map(quoteArg).join(" ");
}

function readToken(
  input: string,
  index: number,
): { readonly value: string; readonly next: number } {
  const current = input[index];
  if (current === "'") {
    let value = "";
    let cursor = index + 1;
    let closed = false;
    while (cursor < input.length) {
      if (input[cursor] === "'") {
        if (input.startsWith(QUOTE_ESCAPE, cursor)) {
          value += "'";
          cursor += QUOTE_ESCAPE.length;
          continue;
        }
        cursor += 1;
        closed = true;
        break;
      }
      const character = input[cursor];
      if (character === undefined) unexpected();
      value += character;
      cursor += 1;
    }
    if (!closed) unexpected();
    return { value, next: cursor };
  }
  if (current === '"') unexpected();
  let cursor = index;
  while (cursor < input.length && input[cursor] !== " ") cursor += 1;
  const value = input.slice(index, cursor);
  if (!BARE.test(value)) unexpected();
  return { value, next: cursor };
}

function splitStrict(input: string): string[] {
  if (input.length === 0) unexpected();
  const tokens: string[] = [];
  let index = 0;
  while (index < input.length) {
    const token = readToken(input, index);
    tokens.push(token.value);
    index = token.next;
    if (index === input.length) break;
    if (input[index] !== " ") unexpected();
    index += 1;
    if (index === input.length || input[index] === " ") unexpected();
  }
  if (quote(tokens) !== input) unexpected();
  return tokens;
}

function isBwrap(token: string): boolean {
  return token === "bwrap" || (token.startsWith("/") && token.endsWith("/bwrap"));
}

export interface LinuxLaunch {
  readonly command: string;
  readonly helperPath: string;
  readonly privileged: boolean;
}

function assertLockedHelper(
  tokens: readonly string[],
  separator: number,
  shell: string,
  launch: LinuxLaunch,
) {
  const wrapper = tokens[separator + 3];
  if (tokens.length !== separator + 4 || wrapper === undefined) throw new Error(HELPER_NOT_IN_USE);
  const inner = splitStrict(wrapper);
  const script = inner[2];
  if (inner.length !== 3 || inner[0] !== shell || inner[1] !== "-c" || script === undefined)
    throw new Error(HELPER_NOT_IN_USE);
  const tail = `${NESTED_USERNS_DENIED} ${quoteArg(launch.helperPath)} ${quote([shell, "-c", launch.command])}`;
  if (script !== tail && !script.endsWith(`\n${tail}`)) throw new Error(HELPER_NOT_IN_USE);
}

export function prepareLinuxLaunchArgv(
  argv: readonly string[],
  shell: string,
  launch: LinuxLaunch,
  resolveTmpfsTarget: (directory: string) => string = (directory) => directory,
): readonly string[] {
  return rewrite(argv, shell, resolveTmpfsTarget, launch);
}

export function rewriteLinuxReadOnlyTmpfs(
  argv: readonly string[],
  shell: string,
  resolveTmpfsTarget: (directory: string) => string = (directory) => directory,
): readonly string[] {
  return rewrite(argv, shell, resolveTmpfsTarget, undefined);
}

function rewrite(
  argv: readonly string[],
  shell: string,
  resolveTmpfsTarget: (directory: string) => string,
  launch: LinuxLaunch | undefined,
): readonly string[] {
  const executable = argv[0];
  const flag = argv[1];
  const command = argv[2];
  if (argv.length !== 3 || executable !== shell || flag !== "-c" || command === undefined)
    unexpected();
  const tokens = splitStrict(command);
  const program = tokens[0];
  if (program === "/bin/sh") throw new Error(ARGUMENT_FILE);
  if (program === undefined || !isBwrap(program)) unexpected();
  const directories: { dest: string; at: number }[] = [];
  const mounts: { dest: string; at: number }[] = [];
  let index = 1;
  let separator = -1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) unexpected();
    if (token === "--") {
      separator = index;
      break;
    }
    if (token === "--args") throw new Error(ARGUMENT_FILE);
    if (token === "--disable-userns") throw new Error(HELPER_NOT_IN_USE);
    if (token === "--cap-add") {
      if (!launch?.privileged || tokens[index + 1] !== "CAP_SETFCAP") unexpected();
      index += 2;
      continue;
    }
    if (ZERO_ARGUMENT_OPTIONS.has(token)) {
      index += 1;
      continue;
    }
    if (ONE_ARGUMENT_OPTIONS.has(token)) {
      const value = tokens[index + 1];
      if (value === undefined) unexpected();
      if (token === "--tmpfs" || token === "--dev" || token === "--proc") {
        mounts.push({ dest: value, at: index });
      }
      if (token === "--tmpfs") directories.push({ dest: value, at: index });
      index += 2;
      continue;
    }
    if (TWO_ARGUMENT_OPTIONS.has(token)) {
      const dest = tokens[index + 2];
      if (tokens[index + 1] === undefined || dest === undefined) unexpected();
      if (token === "--bind" || token === "--ro-bind") mounts.push({ dest, at: index });
      index += 3;
      continue;
    }
    unexpected();
  }
  if (separator < 0) unexpected();
  const shellPath = tokens[separator + 1];
  const shellFlag = tokens[separator + 2];
  if (
    shellPath === undefined ||
    shellPath.length === 0 ||
    shellPath.startsWith("-") ||
    shellFlag !== "-c"
  )
    unexpected();
  if (launch) assertLockedHelper(tokens, separator, shell, launch);
  const kept = directories.filter((entry) => {
    const resolved = resolveTmpfsTarget(entry.dest);
    if (resolved === entry.dest) return true;
    return !mounts.some((mount) => mount.at > entry.at && covers(mount.dest, resolved));
  });
  if (kept.length === 0) return argv;
  const rewritten = [
    ...tokens.slice(0, separator),
    ...kept.flatMap((entry) => ["--remount-ro", entry.dest]),
    ...tokens.slice(separator),
  ];
  return [executable, flag, quote(rewritten)];
}
