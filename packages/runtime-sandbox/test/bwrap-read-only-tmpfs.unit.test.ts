import { describe, expect, it } from "vitest";
import { rewriteLinuxReadOnlyTmpfs } from "../src/bwrap-read-only-tmpfs.ts";

const SHELL = "/bin/bash";
const BARE = /^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/;

function quoteArg(arg: string): string {
  if (arg === "") return "''";
  if (BARE.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'"'"'`)}'`;
}

function quote(args: readonly string[]): string {
  return args.map(quoteArg).join(" ");
}

function launch(command: string): readonly string[] {
  return [SHELL, "-c", command];
}

function rewrite(command: string): readonly string[] {
  return rewriteLinuxReadOnlyTmpfs(launch(command), SHELL);
}

function expectUnexpected(run: () => void) {
  expect(run).toThrowError(/^JOB_HOST_LAUNCH_ARGV_UNEXPECTED$/);
}

describe("Linux bwrap tmpfs read-only rewrite", () => {
  it("remounts every tmpfs, in scan order, after dev and proc and before the separator", () => {
    const commandArgument = "printf 'marker'";
    const prefix = [
      "bwrap",
      "--new-session",
      "--die-with-parent",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-net",
      "--cap-drop",
      "ALL",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/var",
      "--tmpfs",
      "/home",
      "--ro-bind",
      "/",
      "/",
      "--bind",
      "/workspace",
      "/workspace",
      "--setenv",
      "HOME",
      "/private",
      "--setenv",
      "TMPDIR",
      "/private",
      "--unsetenv",
      "DISPLAY",
    ];
    const suffix = ["--", "/bin/bash", "-c", commandArgument];
    const input = launch(quote([...prefix, ...suffix]));
    const output = rewriteLinuxReadOnlyTmpfs(input, SHELL);
    expect(output.slice(0, 2)).toEqual([SHELL, "-c"]);
    expect(output[2]).toBe(
      quote([
        ...prefix,
        "--remount-ro",
        "/tmp",
        "--remount-ro",
        "/var",
        "--remount-ro",
        "/home",
        ...suffix,
      ]),
    );
    const command = String(output[2]);
    expect(command.indexOf("--dev /dev")).toBeLessThan(command.indexOf("--remount-ro"));
    expect(command.indexOf("--proc /proc")).toBeLessThan(command.indexOf("--remount-ro"));
    expect(command.indexOf("--remount-ro /tmp")).toBeLessThan(command.indexOf("--remount-ro /var"));
    expect(command.indexOf("--remount-ro /var")).toBeLessThan(
      command.indexOf("--remount-ro /home"),
    );
    expect(command.indexOf("--remount-ro /home")).toBeLessThan(
      command.indexOf(" -- /bin/bash -c "),
    );
    expect(input[2]).toBe(quote([...prefix, ...suffix]));
  });

  it("accepts an absolute bwrap path and keeps a quoted tmpfs directory", () => {
    const output = rewrite("/usr/bin/bwrap --tmpfs '/work space' -- /bin/bash -c true");
    expect(output[2]).toBe(
      "/usr/bin/bwrap --tmpfs '/work space' --remount-ro '/work space' -- /bin/bash -c true",
    );
  });

  it("treats --setenv values that look like options as values", () => {
    expect(rewrite("bwrap --setenv NAME -- --tmpfs /tmp -- /bin/bash -c true")[2]).toBe(
      "bwrap --setenv NAME -- --tmpfs /tmp --remount-ro /tmp -- /bin/bash -c true",
    );
    expect(rewrite("bwrap --setenv NAME --tmpfs --tmpfs /var -- /bin/bash -c true")[2]).toBe(
      "bwrap --setenv NAME --tmpfs --tmpfs /var --remount-ro /var -- /bin/bash -c true",
    );
    expect(rewrite(`bwrap --setenv NAME 'x -- y'"'"'z' --tmpfs /tmp -- /bin/bash -c true`)[2]).toBe(
      `bwrap --setenv NAME 'x -- y'"'"'z' --tmpfs /tmp --remount-ro /tmp -- /bin/bash -c true`,
    );
  });

  it("round-trips empty, equals-leading, newline, and internal double-space values", () => {
    expect(rewrite("bwrap --setenv NAME '' --tmpfs /tmp -- /bin/bash -c true")[2]).toBe(
      "bwrap --setenv NAME '' --tmpfs /tmp --remount-ro /tmp -- /bin/bash -c true",
    );
    expect(rewrite("bwrap --setenv NAME '=led' --tmpfs /tmp -- /bin/bash -c true")[2]).toBe(
      "bwrap --setenv NAME '=led' --tmpfs /tmp --remount-ro /tmp -- /bin/bash -c true",
    );
    const newline = "a\nb";
    expect(rewrite(`bwrap --setenv NAME '${newline}' --tmpfs /tmp -- /bin/bash -c true`)[2]).toBe(
      `bwrap --setenv NAME '${newline}' --tmpfs /tmp --remount-ro /tmp -- /bin/bash -c true`,
    );
    expect(rewrite("bwrap --setenv NAME 'a  b' --tmpfs /tmp -- /bin/bash -c true")[2]).toBe(
      "bwrap --setenv NAME 'a  b' --tmpfs /tmp --remount-ro /tmp -- /bin/bash -c true",
    );
  });

  it("skips a symlink tmpfs when a later mount covers its target and still remounts /tmp", () => {
    const prefix = [
      "bwrap",
      "--ro-bind",
      "/",
      "/",
      "--tmpfs",
      "/sbin",
      "--tmpfs",
      "/tmp",
      "--bind",
      "/tmp/ws",
      "/tmp/ws",
      "--tmpfs",
      "/usr",
      "--ro-bind",
      "/usr",
      "/usr",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
    ];
    const suffix = ["--", "/bin/bash", "-c", "true"];
    const output = rewriteLinuxReadOnlyTmpfs(
      launch(quote([...prefix, ...suffix])),
      SHELL,
      (directory) => (directory === "/sbin" ? "/usr/sbin" : directory),
    );
    expect(output[2]).toBe(
      quote([...prefix, "--remount-ro", "/tmp", "--remount-ro", "/usr", ...suffix]),
    );
    expect(String(output[2])).not.toContain("--remount-ro /sbin");
  });

  it("still remounts a symlink tmpfs when no later mount covers its target", () => {
    const output = rewriteLinuxReadOnlyTmpfs(
      launch("bwrap --tmpfs /alone -- /bin/bash -c true"),
      SHELL,
      (directory) => (directory === "/alone" ? "/opt/alone" : directory),
    );
    expect(output[2]).toBe("bwrap --tmpfs /alone --remount-ro /alone -- /bin/bash -c true");
  });

  it("returns the same argv when the command has no tmpfs", () => {
    const input = launch(
      "bwrap --new-session --die-with-parent --unshare-net --dev /dev --proc /proc -- /bin/bash -c true",
    );
    expect(rewriteLinuxReadOnlyTmpfs(input, SHELL)).toBe(input);
  });

  it("rejects a command string that quote() would not have emitted", () => {
    expectUnexpected(() => rewrite("bwrap  --dev /dev -- /bin/bash -c true"));
    expectUnexpected(() => rewrite("bwrap --dev '/tmp -- /bin/bash -c true"));
    expectUnexpected(() => rewrite(`bwrap --dev "/tmp" -- /bin/bash -c true`));
    expectUnexpected(() => rewrite(" bwrap --dev /dev -- /bin/bash -c true"));
    expectUnexpected(() => rewrite("bwrap --dev /dev -- /bin/bash -c true "));
    expectUnexpected(() => rewrite(""));
  });

  it("rejects options SRT 0.0.75 does not emit, and a broken bwrap shape", () => {
    for (const command of [
      "bwrap --chdir /workspace -- /bin/bash -c true",
      "bwrap --remount-ro /tmp -- /bin/bash -c true",
      "bwrap --dev-bind /dev /dev -- /bin/bash -c true",
      "bwrap --symlink /bin/bash /tmp/sh -- /bin/bash -c true",
      "bwrap --ro-bind-try / / -- /bin/bash -c true",
      "bwrap --tmpfs /tmp",
      "bwrap --tmpfs /tmp --",
      "bwrap --tmpfs /tmp -- /bin/bash",
      "bwrap --tmpfs /tmp -- -c true",
      "bwrap --setenv ONLY -- /bin/bash -c true",
      "echo hi -- /bin/bash -c true",
      "./bwrap --tmpfs /tmp -- /bin/bash -c true",
      "/usr/bin/not-bwrap --tmpfs /tmp -- /bin/bash -c true",
    ])
      expectUnexpected(() => rewrite(command));
    expectUnexpected(() => rewriteLinuxReadOnlyTmpfs([SHELL, "-c"], SHELL));
    expectUnexpected(() =>
      rewriteLinuxReadOnlyTmpfs([SHELL, "-c", "bwrap -- /bin/bash -c true", "extra"], SHELL),
    );
    expectUnexpected(() =>
      rewriteLinuxReadOnlyTmpfs(["/bin/sh", "-c", "bwrap -- /bin/bash -c true"], SHELL),
    );
    expectUnexpected(() =>
      rewriteLinuxReadOnlyTmpfs([SHELL, "-lc", "bwrap -- /bin/bash -c true"], SHELL),
    );
  });
});
