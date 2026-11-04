import { spawnSync } from "node:child_process";
import {
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NOBODY = 65534;
const SHELL = "/bin/bash";
const ORIGINAL = "[core]\n\trepositoryformatversion = 0\n";
const script = fileURLToPath(import.meta.url);

const PROBE = String.raw`
import ctypes, errno, json, os, platform, socket, sys
libc = ctypes.CDLL(None, use_errno=True)
def name(code):
    return errno.errorcode.get(code, str(code))
def report(ok, code=None, stage=None):
    print(json.dumps({"ok": ok, "errno": code, "stage": stage}), flush=True)
mode = sys.argv[1]
if mode == "vsock":
    try:
        socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM).close()
        report(True)
    except OSError as error:
        report(False, name(error.errno))
elif mode == "io_uring":
    params = ctypes.create_string_buffer(120)
    fd = libc.syscall(425, 1, params)
    if fd >= 0:
        os.close(fd)
        report(True)
    else:
        report(False, name(ctypes.get_errno()))
elif mode == "write":
    try:
        with open(sys.argv[2], "w") as handle:
            handle.write("written")
        report(True)
    except OSError as error:
        report(False, name(error.errno))
elif mode == "nested":
    CLONE_NEWNS, CLONE_NEWUSER = 0x00020000, 0x10000000
    MS_REC, MS_PRIVATE, MNT_DETACH = 16384, 1 << 18, 2
    PIVOT_ROOT = {"x86_64": 155, "aarch64": 41}[platform.machine()]
    holder = os.open(os.path.join(sys.argv[2], ".git"), os.O_PATH | os.O_DIRECTORY)
    uid, gid = os.getuid(), os.getgid()
    def replace():
        try:
            os.rename("config", "config.aside", src_dir_fd=holder, dst_dir_fd=holder)
            fd = os.open("config", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644, dir_fd=holder)
            os.write(fd, b"[core]\n\tplanted = true\n")
            os.close(fd)
            return None
        except OSError as error:
            return name(error.errno)
    def call(stage, rc):
        if rc != 0:
            raise OSError(ctypes.get_errno(), stage)
    direct = replace()
    if direct is None:
        report(True, None, "direct")
        sys.exit(0)
    try:
        call("unshare", libc.unshare(CLONE_NEWUSER | CLONE_NEWNS))
        open("/proc/self/setgroups", "w").write("deny")
        open("/proc/self/uid_map", "w").write("0 %d 1" % uid)
        open("/proc/self/gid_map", "w").write("0 %d 1" % gid)
        call("make-private", libc.mount(None, b"/", None, MS_REC | MS_PRIVATE, None))
        onto = b"/usr" if os.path.isdir("/usr") else b"/tmp"
        call("tmpfs", libc.mount(b"tmpfs", onto, b"tmpfs", 0, None))
        os.chdir(onto)
        os.mkdir("old")
        call("pivot_root", libc.syscall(PIVOT_ROOT, b".", b"old"))
        call("detach", libc.umount2(b"/old", MNT_DETACH))
        nested = replace()
        report(nested is None, nested, "nested")
    except OSError as error:
        report(False, name(error.errno), error.strerror)
`;

function rerunAsNobody() {
  const root = mkdtempSync(path.join(tmpdir(), "srt-boundary-"));
  try {
    chownSync(root, NOBODY, NOBODY);
    const child = spawnSync(process.execPath, [script], {
      uid: NOBODY,
      gid: NOBODY,
      stdio: "inherit",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: root,
        TMPDIR: root,
        SRT_BOUNDARY_ROOT: root,
      },
    });
    return child.status ?? 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  const { SANDBOX_RUNTIME_VERSION } = await import("@himawari-agent/execution-contracts");
  const { compileSandboxPolicy } = await import("../src/policy.ts");
  const { prepareLinuxLaunchArgv, resolveLinuxTmpfsDestination } = await import(
    "../src/bwrap-read-only-tmpfs.ts"
  );
  const { installedSrtPackageRoot, readSrtRuntimeIdentity, requireLockedSrtRuntime } = await import(
    "../src/srt-runtime-identity.ts"
  );

  const base = realpathSync(
    process.env["SRT_BOUNDARY_ROOT"] ?? mkdtempSync(path.join(tmpdir(), "srt-boundary-")),
  );
  const root = mkdtempSync(path.join(base, "run-"));
  const workspace = path.join(root, "workspace");
  const privateDirectory = path.join(root, "private");
  const secret = path.join(workspace, "secret");
  const git = path.join(workspace, ".git");
  mkdirSync(git, { recursive: true });
  mkdirSync(secret);
  mkdirSync(privateDirectory);
  writeFileSync(path.join(secret, "kept"), "secret");
  const probe = path.join(privateDirectory, "probe.py");
  writeFileSync(probe, PROBE);
  process.env["HOME"] = privateDirectory;
  process.env["TMPDIR"] = privateDirectory;
  process.chdir(workspace);

  const python = realpathSync(
    spawnSync("/bin/sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim(),
  );
  const identity = await readSrtRuntimeIdentity(installedSrtPackageRoot());
  const results = [];
  const record = (name, passed, detail) => {
    results.push({ name, passed, ...detail });
  };
  const { helperPath } = requireLockedSrtRuntime(identity, SANDBOX_RUNTIME_VERSION);
  const toolchain = [
    ...new Set(
      [
        "/usr",
        "/bin",
        "/lib",
        "/lib64",
        "/etc",
        path.dirname(path.dirname(python)),
        path.dirname(path.dirname(helperPath)),
      ]
        .filter((entry) => existsSync(entry))
        .map((entry) => realpathSync(entry)),
    ),
  ].filter(
    (entry, _index, all) => !all.some((other) => other !== entry && entry.startsWith(`${other}/`)),
  );
  const compiled = await compileSandboxPolicy({
    workspace,
    writable: true,
    privateDirectory,
    readOnlyToolchainPaths: toolchain,
    protectedPaths: [secret],
    allowedDomains: [],
  });
  const locked = { ...JSON.parse(compiled.policyJson), seccomp: { applyPath: helperPath } };
  const resetGit = () => {
    rmSync(path.join(git, "config.aside"), { force: true });
    writeFileSync(path.join(git, "config"), ORIGINAL);
  };
  const outcome = (child) => {
    const line = child.stdout?.trim().split("\n").at(-1) ?? "";
    try {
      return { ...JSON.parse(line), status: child.status };
    } catch {
      return {
        ok: null,
        status: child.status,
        stdout: child.stdout,
        stderr: child.stderr?.slice(-400),
      };
    }
  };
  const sandboxed = async (configuration, command, checked) => {
    await SandboxManager.initialize(configuration, undefined, false);
    try {
      const wrapped = await SandboxManager.wrapWithSandboxArgv(command, SHELL);
      const argv = checked
        ? prepareLinuxLaunchArgv(
            wrapped.argv,
            SHELL,
            { command, helperPath, privileged: process.geteuid() === 0 },
            resolveLinuxTmpfsDestination,
          )
        : wrapped.argv;
      return spawnSync(argv[0], argv.slice(1), {
        cwd: workspace,
        env: wrapped.env,
        encoding: "utf8",
        timeout: 60_000,
      });
    } finally {
      SandboxManager.cleanupAfterCommand();
      await SandboxManager.reset();
    }
  };
  const quoted = (words) => words.map((word) => `'${word.replaceAll("'", `'"'"'`)}'`).join(" ");
  const host = (mode) => outcome(spawnSync(python, [probe, mode], { encoding: "utf8" }));

  const plain = await sandboxed(locked, "echo boundary-ready", true);
  record(
    "locked sandbox runs a command",
    plain.status === 0 && plain.stdout.trim() === "boundary-ready",
    {
      status: plain.status,
      stderr: plain.stderr?.slice(-400),
    },
  );

  resetGit();
  const nested = outcome(
    await sandboxed(locked, quoted([python, probe, "nested", workspace]), true),
  );
  const nestedFile = readFileSync(path.join(git, "config"), "utf8");
  resetGit();
  const nestedControl = outcome(
    await sandboxed(
      { ...locked, allowNestedUserNamespaces: true },
      quoted([python, probe, "nested", workspace]),
      false,
    ),
  );
  const controlFile = readFileSync(path.join(git, "config"), "utf8");
  resetGit();
  record(
    "nested user namespace cannot rewrite a write-denied file",
    nested.ok === false &&
      nested.errno === "EPERM" &&
      nested.stage === "unshare" &&
      nestedFile === ORIGINAL,
    { observed: nested, fileUnchanged: nestedFile === ORIGINAL },
  );
  record(
    "control: the same attack rewrites the file when nested namespaces are allowed",
    nestedControl.ok === true && controlFile !== ORIGINAL,
    { observed: nestedControl },
  );

  for (const mode of ["vsock", "io_uring"]) {
    const inside = outcome(await sandboxed(locked, quoted([python, probe, mode]), true));
    const outside = host(mode);
    record(
      `${mode} is refused by the seccomp helper`,
      inside.ok === false && inside.errno === "EPERM",
      {
        observed: inside,
      },
    );
    record(`control: ${mode} works outside the sandbox`, outside.ok === true, {
      observed: outside,
    });
  }

  const target = path.join(secret, "planted");
  const rewritten = outcome(
    await sandboxed(locked, quoted([python, probe, "write", target]), true),
  );
  const unrewritten = outcome(
    await sandboxed(locked, quoted([python, probe, "write", target]), false),
  );
  record(
    "write into a read-denied directory fails once its tmpfs is remounted read-only",
    rewritten.ok === false && rewritten.errno === "EROFS",
    {
      observed: rewritten,
    },
  );
  record(
    "control: without the remount the same write succeeds inside the sandbox",
    unrewritten.ok === true,
    {
      observed: unrewritten,
    },
  );
  record("the host copy of the read-denied directory is untouched", !existsSync(target), {});

  let helperless;
  try {
    await sandboxed(
      { ...locked, network: { ...locked.network, allowAllUnixSockets: true } },
      "echo no-helper",
      true,
    );
    helperless = "launched";
  } catch (error) {
    helperless = error instanceof Error ? error.message : String(error);
  }
  record(
    "a launch that SRT builds without the seccomp helper is refused",
    helperless === "JOB_HOST_SECCOMP_HELPER_NOT_IN_USE",
    {
      observed: helperless,
    },
  );
  let missing;
  try {
    requireLockedSrtRuntime({ ...identity, helper: null }, SANDBOX_RUNTIME_VERSION);
    missing = "accepted";
  } catch (error) {
    missing = error instanceof Error ? error.message : String(error);
  }
  record(
    "a runtime without the seccomp helper is refused before start",
    missing === "JOB_HOST_SECCOMP_HELPER_UNAVAILABLE",
    {
      observed: missing,
    },
  );

  rmSync(root, { recursive: true, force: true });
  if (!process.env["SRT_BOUNDARY_ROOT"]) rmSync(base, { recursive: true, force: true });
  const passed = results.every((result) => result.passed);
  console.log(
    JSON.stringify(
      {
        passed,
        srtVersion: identity.version,
        bwrapVersion: identity.bwrapVersion,
        uid: process.getuid(),
        results,
      },
      null,
      2,
    ),
  );
  return passed ? 0 : 1;
}

if (process.platform !== "linux") {
  console.log(JSON.stringify({ passed: false, reason: "SRT_BOUNDARY_LINUX_ONLY" }));
  process.exitCode = 1;
} else if (process.geteuid() === 0) {
  process.exitCode = rerunAsNobody();
} else {
  process.exitCode = await main().catch((error) => {
    console.log(
      JSON.stringify({
        passed: false,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    return 1;
  });
}
