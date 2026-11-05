import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scripts = path.resolve(import.meta.dirname, "../../scripts/operations/hermes-runner");
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const sandbox = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hermes-runner-scripts-"));
  directories.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const fake = (name, body) => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/bash\n${body}\n`);
    chmodSync(file, 0o755);
  };
  const run = (script, args = [], { inheritPath = true, input = "" } = {}) =>
    spawnSync("/bin/bash", [path.join(scripts, script), ...args], {
      encoding: "utf8",
      input,
      env: { PATH: inheritPath ? `${bin}:${process.env.PATH}` : bin, HOME: root },
    });
  const calls = (name = "calls") => {
    const file = path.join(root, name);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  const record = (name) => `printf '${name} %s\\n' "$*" >> "${root}/calls"`;
  return { root, fake, run, calls, record };
};

const fakeRunnerAccounts = (box, present) => {
  const uids = { "gh-runner": 996, "gh-runner-2": 995 };
  const lines = Object.entries(uids).map(
    ([user, uid]) =>
      `if [ "\${@: -1}" = ${user} ]; then [ -e "${box.root}/gone-${user}" ] && exit 1; ${
        present.includes(user) ? `[ "$1" = -u ] && echo ${uid}; exit 0` : "exit 1"
      }; fi`,
  );
  box.fake("id", `${lines.join("\n")}\n[ "$1" = -u ] && echo 0\nexit 0`);
};

const shell = (body) =>
  spawnSync("/bin/bash", ["-c", `source "${scripts}/runners.sh"\n${body}`], { encoding: "utf8" });

const unitSettings = (text) =>
  Object.fromEntries(
    text
      .split("\n")
      .filter((line) => /^[A-Za-z]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

const bytes = (value) => {
  const match = /^(\d+)([KMG]?)$/.exec(value);
  return Number(match[1]) * { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2]];
};

describe("job-started.sh disk floor", () => {
  const withDf = (dfBody) => {
    const box = sandbox();
    box.fake("df", `printf '%s\\n' "$*" > "${box.root}/df-args"\n${dfBody}`);
    const log = path.join(box.root, "disk.log");
    const result = box.run("job-started.sh", ["/srv/target", log]);
    return { ...box, log, result };
  };

  it("lets the job start when the target disk has more than 16 GiB free", () => {
    const { root, log, result } = withDf("printf ' Avail\\n%s\\n' 20000000000");
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(root, "df-args"), "utf8")).toContain("/srv/target");
    expect(readFileSync(log, "utf8")).toContain("avail=20000000000");
  });

  it("refuses the job with 10 GiB free because two jobs may share the disk", () => {
    const { result } = withDf(`printf ' Avail\\n%s\\n' ${10 * 1024 ** 3}`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("below the 16 GiB floor");
  });

  it("refuses the job when df prints no number", () => {
    const { result } = withDf("printf ' Avail\\n'");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("could not read free space");
  });

  it("refuses the job when df fails", () => {
    const { result } = withDf("echo 'df: /srv/target: No such file' >&2; exit 1");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("could not read free space");
  });
});

describe("runner-pause.sh", () => {
  const pauseBox = ({ pgrep = "exit 1", accounts = ["gh-runner", "gh-runner-2"] } = {}) => {
    const box = sandbox();
    fakeRunnerAccounts(box, accounts);
    box.fake("pgrep", pgrep);
    box.fake("sleep", "exit 0");
    box.fake("sudo", `printf '%s\\n' "$*" >> "${box.root}/sudo-calls"`);
    box.fake("systemctl", "exit 3");
    return box;
  };

  it.each(["abc", "0", "-5", "86401", "999999999999999999999", "1.5"])(
    "rejects limit %s before touching the service",
    (limit) => {
      const { run, calls } = pauseBox();
      const result = run("runner-pause.sh", [limit]);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain("1-86400");
      expect(calls("sudo-calls")).toBe("");
    },
  );

  it("stops both runners when neither is running a job", () => {
    const { run, calls } = pauseBox();
    const result = run("runner-pause.sh", ["86400"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RUNNER_PAUSED");
    expect(calls("sudo-calls")).toBe(
      "-n /usr/bin/systemctl stop gh-runner.service\n-n /usr/bin/systemctl stop gh-runner-2.service\n",
    );
  });

  it("stops only the first runner when the second account does not exist", () => {
    const { run, calls } = pauseBox({ accounts: ["gh-runner"] });
    const result = run("runner-pause.sh", ["60"]);
    expect(result.status).toBe(0);
    expect(calls("sudo-calls")).toBe("-n /usr/bin/systemctl stop gh-runner.service\n");
  });

  it("leaves both runners running while the second one still has a job", () => {
    const { run, calls } = pauseBox({ pgrep: '[ "$2" = gh-runner-2 ] && exit 0\nexit 1' });
    const result = run("runner-pause.sh", ["30"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("RUNNER_BUSY_TIMEOUT");
    expect(calls("sudo-calls")).toBe("");
  });

  it("does not stop anything when pgrep itself fails", () => {
    const { run, calls } = pauseBox({ pgrep: "exit 3" });
    const result = run("runner-pause.sh", ["60"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("RUNNER_PAUSE_FAILED");
    expect(calls("sudo-calls")).toBe("");
  });
});

describe("runner-resume.sh", () => {
  const resumeBox = (enabled) => {
    const box = sandbox();
    fakeRunnerAccounts(box, ["gh-runner", "gh-runner-2"]);
    box.fake("sleep", "exit 0");
    box.fake("sudo", `printf '%s\\n' "$*" >> "${box.root}/sudo-calls"`);
    box.fake(
      "systemctl",
      `case "$1" in is-enabled) case "\${@: -1}" in ${enabled.map((unit) => `${unit}) exit 0 ;;`).join(" ")} *) exit 1 ;; esac ;; *) exit 0 ;; esac`,
    );
    return box;
  };

  it("starts every registered runner", () => {
    const { run, calls } = resumeBox(["gh-runner.service", "gh-runner-2.service"]);
    const result = run("runner-resume.sh");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RUNNER_RESUMED");
    expect(calls("sudo-calls")).toBe(
      "-n /usr/bin/systemctl start gh-runner.service\n-n /usr/bin/systemctl start gh-runner-2.service\n",
    );
  });

  it("does not start a runner that was installed but never registered", () => {
    const { run, calls } = resumeBox(["gh-runner.service"]);
    const result = run("runner-resume.sh");
    expect(result.status).toBe(0);
    expect(calls("sudo-calls")).toBe("-n /usr/bin/systemctl start gh-runner.service\n");
  });
});

describe("clean-old.sh", () => {
  it("skips cleaning and reports failure when pgrep itself fails", () => {
    const box = sandbox();
    fakeRunnerAccounts(box, ["gh-runner", "gh-runner-2"]);
    box.fake("pgrep", "exit 3");
    box.fake("find", `${box.record("find")}\nexit 0`);
    const result = box.run("clean-old.sh");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CLEAN_SKIPPED");
    expect(box.calls()).not.toContain("find");
  });
});

describe("runner units and shared limits", () => {
  const template = path.join(scripts, "gh-runner.service.in");
  const render = (id) => shell(`render_runner_unit ${id} "${template}"`);
  const slice = () => unitSettings(readFileSync(path.join(scripts, "gh-runners.slice"), "utf8"));

  it("caps both runners together at 3 cores and 6 GB with low priority against other services", () => {
    expect(slice()).toMatchObject({
      CPUQuota: "300%",
      MemoryHigh: "5632M",
      MemoryMax: "6G",
      MemorySwapMax: "0",
      CPUWeight: "20",
      IOWeight: "20",
    });
    expect(bytes(slice().MemoryHigh)).toBeLessThan(bytes(slice().MemoryMax));
  });

  it.each([
    [1, "gh-runner", "/srv/gh-runner", "/srv/gh-runner-2", "hermes-home"],
    [2, "gh-runner-2", "/srv/gh-runner-2", "/srv/gh-runner", "hermes-home-2"],
  ])(
    "runner %s runs as its own account inside the shared slice and cannot see the other runner",
    (id, user, root, other, name) => {
      const result = render(id);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("@");
      const unit = unitSettings(result.stdout);
      expect(unit).toMatchObject({
        Slice: "gh-runners.slice",
        User: user,
        Group: user,
        WorkingDirectory: `${root}/runner`,
        CPUQuota: "200%",
        MemoryHigh: "4608M",
        MemoryMax: "5G",
        ProtectProc: "invisible",
        ReadWritePaths: `${root}/runner ${root}/home ${root}/logs`,
      });
      expect(unit.Description).toContain(name);
      expect(unit.InaccessiblePaths.split(" ")).toEqual(
        expect.arrayContaining(["/data", `-${other}`]),
      );
      expect(bytes(unit.MemoryMax)).toBeLessThanOrEqual(bytes(slice().MemoryMax));
    },
  );

  it("gives both runners the same hardening apart from their own paths and names", () => {
    const normalize = (id, text) =>
      text
        .replaceAll(id === 1 ? "hermes-home" : "hermes-home-2", "NAME")
        .replace(id === 1 ? /\/srv\/gh-runner(?!-2)/g : /\/srv\/gh-runner-2/g, "ROOT");
    const first = render(1).stdout;
    const second = render(2).stdout;
    const swapOther = (text) => text.replace(/-\/srv\/gh-runner(-2)?$/m, "-OTHER");
    expect(swapOther(normalize(1, first)).replace(/User=gh-runner\n|Group=gh-runner\n/g, "")).toBe(
      swapOther(normalize(2, second)).replace(/User=gh-runner-2\n|Group=gh-runner-2\n/g, ""),
    );
  });

  it("rejects an unknown runner number", () => {
    expect(render(3).status).not.toBe(0);
  });

  it("firewall rules apply to every runner account", () => {
    const result = shell('runner_firewall_rules "996, 995" "22,8080"');
    const ruleLines = result.stdout.split("\n").filter((line) => line.includes("reject"));
    expect(ruleLines).toHaveLength(4);
    for (const line of ruleLines) expect(line).toContain("meta skuid { 996, 995 }");
    expect(result.stdout).toContain("tcp dport { 22,8080 }");
  });

  it("andy may only start, stop and restart the runner services", () => {
    const result = shell("runner_sudoers_line 1 2");
    expect(result.stdout).toBe(
      "andy ALL=(root) NOPASSWD: " +
        [
          "/usr/bin/systemctl start gh-runner.service",
          "/usr/bin/systemctl stop gh-runner.service",
          "/usr/bin/systemctl restart gh-runner.service",
          "/usr/bin/systemctl start gh-runner-2.service",
          "/usr/bin/systemctl stop gh-runner-2.service",
          "/usr/bin/systemctl restart gh-runner-2.service",
        ].join(", ") +
        "\n",
    );
  });
});

describe("root scripts refuse other hosts", () => {
  it.each(["install-runner.sh", "register-runner.sh", "uninstall-runner.sh"])(
    "%s stops before any account or file change on another host",
    (script) => {
      const { root, fake, run } = sandbox();
      fake("hostname", "echo laptop");
      fake("id", `printf '%s\\n' "$*" >> "${root}/id-calls"; exit 1`);
      const result = run(script);
      expect(result.status).toBe(68);
      expect(result.stderr).toContain("only runs on hermes-home");
      expect(existsSync(path.join(root, "id-calls"))).toBe(false);
    },
  );

  it.each(["install-runner.sh", "register-runner.sh", "uninstall-runner.sh"])(
    "%s passes the host check on hermes-home and still requires root",
    (script) => {
      const { fake, run } = sandbox();
      fake("hostname", "echo hermes-home");
      fake("id", "echo 1000");
      const result = run(script);
      expect(result.status).toBe(65);
      expect(result.stderr).toContain("run it with sudo");
    },
  );

  it("register-runner.sh names a missing python3 before asking for the token", () => {
    const { fake, run } = sandbox();
    fake("hostname", "echo hermes-home");
    const result = run("register-runner.sh", [], { inheritPath: false });
    expect(result.status).toBe(66);
    expect(result.stderr).toContain("missing python3");
  });
});

describe("register-runner.sh arguments", () => {
  const registerBox = () => {
    const box = sandbox();
    box.fake("hostname", "echo hermes-home");
    box.fake("id", "echo 0");
    box.fake("sudo", `${box.record("sudo")}\nexit 0`);
    return box;
  };

  it("refuses to run without naming which runner to register", () => {
    const { run, calls } = registerBox();
    const result = run("register-runner.sh", [], { input: "token\n" });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("usage");
    expect(calls()).toBe("");
  });

  it("reports a missing token with exit code 64", () => {
    const { run, calls } = registerBox();
    const result = run("register-runner.sh", ["2"]);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("no registration token");
    expect(calls()).toBe("");
  });
});

describe("install-runner.sh", () => {
  it("refuses to change anything while a runner service is active", () => {
    const box = sandbox();
    box.fake("hostname", "echo hermes-home");
    fakeRunnerAccounts(box, ["gh-runner"]);
    for (const tool of ["nft", "visudo", "useradd", "sha256sum", "curl", "ss", "python3"])
      box.fake(tool, `${box.record(tool)}\nexit 0`);
    box.fake("systemctl", `${box.record("systemctl")}\n[ "$1" = is-active ] && exit 0\nexit 0`);
    box.fake("install", `${box.record("install")}\nexit 0`);
    box.fake("sudo", `${box.record("sudo")}\nexit 0`);
    const result = box.run("install-runner.sh");
    expect(result.status).toBe(70);
    expect(result.stderr).toContain("runner-pause.sh");
    expect(box.calls()).not.toMatch(/^(useradd|install|nft|sudo) /m);
  });
});

describe("uninstall-runner.sh", () => {
  const uninstallBox = () => {
    const box = sandbox();
    box.fake("hostname", "echo hermes-home");
    for (const name of ["systemctl", "rm", "pkill", "groupdel"])
      box.fake(name, `${box.record(name)}\nexit 0`);
    box.fake("getent", `${box.record("getent")}\nexit 2`);
    return box;
  };

  it("asks which runner to remove", () => {
    const box = uninstallBox();
    fakeRunnerAccounts(box, ["gh-runner", "gh-runner-2"]);
    box.fake("nft", "exit 0");
    box.fake("userdel", `${box.record("userdel")}\nexit 0`);
    const result = box.run("uninstall-runner.sh");
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("usage");
    expect(box.calls()).toBe("");
  });

  it("refuses to report success when nft is missing", () => {
    const box = uninstallBox();
    box.fake("id", '[ "$1" = -u ] && echo 0 && exit 0\nexit 1');
    box.fake("userdel", "exit 0");
    const result = box.run("uninstall-runner.sh", ["all"], { inheritPath: false });
    expect(result.status).toBe(66);
    expect(result.stderr).toContain("missing nft");
    expect(result.stdout).not.toContain("UNINSTALL_OK");
  });

  it("reports UNINSTALL_INCOMPLETE instead of success when the accounts survive", () => {
    const box = uninstallBox();
    box.fake("id", `${box.record("id")}\n[ "$1" = -u ] && echo 0\nexit 0`);
    box.fake("nft", `${box.record("nft")}\nexit 0`);
    box.fake("userdel", `${box.record("userdel")}\nexit 0`);
    const result = box.run("uninstall-runner.sh", ["all"], { inheritPath: false });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("UNINSTALL_OK");
    expect(result.stderr).toContain("UNINSTALL_INCOMPLETE");
    expect(result.stderr).toContain("user:gh-runner ");
    expect(result.stderr).toContain("user:gh-runner-2");
    expect(result.stderr).toContain("nft:inet/gh_runner");
    expect(box.calls()).toContain("userdel gh-runner\n");
    expect(box.calls()).toContain("userdel gh-runner-2\n");
  });

  it("removing only the second runner leaves the first runner, its service and its firewall rule alone", () => {
    const box = uninstallBox();
    fakeRunnerAccounts(box, ["gh-runner", "gh-runner-2"]);
    box.fake("userdel", `${box.record("userdel")}\ntouch "${box.root}/gone-$1"\nexit 0`);
    box.fake(
      "nft",
      `${box.record("nft")}\n[ "$1" = -c ] && cp "$3" "${box.root}/nft-checked"\nexit 0`,
    );
    box.fake("visudo", `cp "$2" "${box.root}/sudoers-checked"\nexit 0`);
    box.fake("install", `${box.record("install")}\nexit 0`);
    box.fake(
      "ss",
      "printf '%s\\n' 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*' 'LISTEN 0 511 127.0.0.1:8080 0.0.0.0:*'",
    );
    box.run("uninstall-runner.sh", ["2"]);
    const calls = box.calls();
    expect(calls).toContain("systemctl disable --now gh-runner-2.service\n");
    expect(calls).toContain("userdel gh-runner-2\n");
    expect(calls).toContain("rm -rf /srv/gh-runner-2\n");
    expect(calls).not.toContain("gh-runner.service");
    expect(calls).not.toMatch(/userdel gh-runner\n|pkill -u gh-runner\n|\/srv\/gh-runner(\s|\/|$)/);
    expect(calls).not.toContain("nft delete table");
    expect(readFileSync(path.join(box.root, "nft-checked"), "utf8")).toContain(
      "meta skuid { 996 }",
    );
    expect(readFileSync(path.join(box.root, "sudoers-checked"), "utf8")).toBe(
      "andy ALL=(root) NOPASSWD: /usr/bin/systemctl start gh-runner.service, /usr/bin/systemctl stop gh-runner.service, /usr/bin/systemctl restart gh-runner.service\n",
    );
  });
});
