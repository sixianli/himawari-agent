import { describe, expect, it } from "vitest";
import { prepareLinuxLaunchArgv, rewriteLinuxReadOnlyTmpfs } from "../src/bwrap-read-only-tmpfs.ts";

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

  it("rejects options SRT does not emit, and a broken bwrap shape", () => {
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

describe("Linux launch with the locked seccomp helper", () => {
  const HELPER =
    "/runtime/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp";
  const COMMAND = "printf 'ready' >&2; exec /usr/bin/node -e \"console.log('a b')\"";
  const NETWORK =
    "{ socat TCP6-LISTEN:3128 UNIX-CONNECT:/tmp/http.sock; } >/dev/null 2>&1 &\n_srt_http=$!";
  const tail = (command: string, helper = HELPER) =>
    `SRT_ALLOW_NESTED_USERNS=0 ${quoteArg(helper)} ${quote([SHELL, "-c", command])}`;
  const wrapped = (options: readonly string[], script: string) =>
    launch(quote(["bwrap", ...options, "--", SHELL, "-c", quote([SHELL, "-c", script])]));
  const BASE = [
    "--new-session",
    "--die-with-parent",
    "--unshare-net",
    "--tmpfs",
    "/tmp",
    "--cap-drop",
    "ALL",
  ];
  const prepare = (argv: readonly string[], privileged = false, command = COMMAND) =>
    prepareLinuxLaunchArgv(argv, SHELL, { command, helperPath: HELPER, privileged });

  it("accepts the command SRT 0.0.81 builds and still remounts each tmpfs read-only", () => {
    const script = `${NETWORK}\n${tail(COMMAND)}`;
    expect(prepare(wrapped(BASE, script))).toEqual(
      wrapped([...BASE, "--remount-ro", "/tmp"], script),
    );
    expect(prepare(wrapped(BASE, tail(COMMAND)))).toEqual(
      wrapped([...BASE, "--remount-ro", "/tmp"], tail(COMMAND)),
    );
  });

  it("accepts --cap-add CAP_SETFCAP only for a root launch", () => {
    const argv = wrapped([...BASE, "--cap-add", "CAP_SETFCAP"], tail(COMMAND));
    expect(prepare(argv, true)).toEqual(
      wrapped([...BASE, "--cap-add", "CAP_SETFCAP", "--remount-ro", "/tmp"], tail(COMMAND)),
    );
    expect(() => prepare(argv, false)).toThrow("JOB_HOST_LAUNCH_ARGV_UNEXPECTED");
    expect(() =>
      prepare(wrapped([...BASE, "--cap-add", "CAP_SYS_ADMIN"], tail(COMMAND)), true),
    ).toThrow("JOB_HOST_LAUNCH_ARGV_UNEXPECTED");
  });

  it.each([
    [
      "no helper prefix",
      wrapped(BASE, `${NETWORK}\n${quoteArg(HELPER)} ${quote([SHELL, "-c", COMMAND])}`),
    ],
    ["no helper at all", wrapped(BASE, `${NETWORK}\n${quote([SHELL, "-c", COMMAND])}`)],
    [
      "another helper",
      wrapped(BASE, `${NETWORK}\n${tail(COMMAND, "/usr/lib/node_modules/x/apply-seccomp")}`),
    ],
    ["a different command", wrapped(BASE, `${NETWORK}\n${tail("true")}`)],
    ["text after the command", wrapped(BASE, `${NETWORK}\n${tail(COMMAND)}\ntrue`)],
    ["--disable-userns", wrapped([...BASE, "--disable-userns"], tail(COMMAND))],
    [
      "an extra word after the wrapper",
      launch(
        `${quote(["bwrap", ...BASE, "--", SHELL, "-c", quote([SHELL, "-c", tail(COMMAND)])])} extra`,
      ),
    ],
    [
      "a wrapper that is not a shell",
      launch(quote(["bwrap", ...BASE, "--", SHELL, "-c", quote(["/bin/sh", "-c", tail(COMMAND)])])),
    ],
  ])("refuses a launch with %s", (_label, argv) => {
    expect(() => prepare(argv)).toThrow("JOB_HOST_SECCOMP_HELPER_NOT_IN_USE");
  });

  it("cannot be satisfied by a user command that prints the helper line itself", () => {
    const forged = `true\n${tail("echo pwned")}`;
    const script = `${NETWORK}\n${tail(forged)}`;
    expect(() => prepare(wrapped(BASE, script), false, "echo pwned")).toThrow(
      "JOB_HOST_SECCOMP_HELPER_NOT_IN_USE",
    );
    expect(prepare(wrapped(BASE, script), false, forged)).toEqual(
      wrapped([...BASE, "--remount-ro", "/tmp"], script),
    );
  });

  it("refuses mounts passed through an argument file with its own code", () => {
    const viaFile = launch(
      quote([
        "/bin/sh",
        "-c",
        'exec 3<"$1" && shift && exec "$@"',
        "srt-args",
        "/proc/self/fd/3",
        "bwrap",
        "--new-session",
        "--args",
        "3",
        "--",
        SHELL,
        "-c",
        quote([SHELL, "-c", tail(COMMAND)]),
      ]),
    );
    expect(() => prepare(viaFile)).toThrow("JOB_HOST_LAUNCH_ARGV_FILE_UNSUPPORTED");
    expect(() => prepare(wrapped([...BASE, "--args", "3"], tail(COMMAND)))).toThrow(
      "JOB_HOST_LAUNCH_ARGV_FILE_UNSUPPORTED",
    );
  });

  it("keeps refusing --dev-bind, which SRT uses only for its own probe", () => {
    expect(() => prepare(wrapped([...BASE, "--dev-bind", "/", "/"], tail(COMMAND)))).toThrow(
      "JOB_HOST_LAUNCH_ARGV_UNEXPECTED",
    );
  });
});
