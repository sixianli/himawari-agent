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
  const run = (script, args = [], { inheritPath = true } = {}) =>
    spawnSync("/bin/bash", [path.join(scripts, script), ...args], {
      encoding: "utf8",
      input: "",
      env: { PATH: inheritPath ? `${bin}:${process.env.PATH}` : bin, HOME: root },
    });
  return { root, fake, run };
};

describe("job-started.sh disk floor", () => {
  const withDf = (dfBody) => {
    const box = sandbox();
    box.fake("df", `printf '%s\\n' "$*" > "${box.root}/df-args"\n${dfBody}`);
    const log = path.join(box.root, "disk.log");
    const result = box.run("job-started.sh", ["/srv/target", log]);
    return { ...box, log, result };
  };

  it("lets the job start when the target disk has more than 8 GiB free", () => {
    const { root, log, result } = withDf("printf ' Avail\\n%s\\n' 20000000000");
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(root, "df-args"), "utf8")).toContain("/srv/target");
    expect(readFileSync(log, "utf8")).toContain("avail=20000000000");
  });

  it("refuses the job below 8 GiB", () => {
    const { result } = withDf("printf ' Avail\\n%s\\n' 1000");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("below the 8 GiB floor");
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

describe("runner-pause.sh wait limit", () => {
  const pauseBox = () => {
    const box = sandbox();
    box.fake("pgrep", "exit 1");
    box.fake("sudo", `printf '%s\\n' "$*" >> "${box.root}/sudo-calls"`);
    box.fake("systemctl", "exit 3");
    return box;
  };

  it.each(["abc", "0", "-5", "86401", "999999999999999999999", "1.5"])(
    "rejects limit %s before touching the service",
    (limit) => {
      const { root, run } = pauseBox();
      const result = run("runner-pause.sh", [limit]);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain("1-86400");
      expect(existsSync(path.join(root, "sudo-calls"))).toBe(false);
    },
  );

  it("stops the service when no job is running and the limit is valid", () => {
    const { root, run } = pauseBox();
    const result = run("runner-pause.sh", ["86400"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RUNNER_PAUSED");
    expect(readFileSync(path.join(root, "sudo-calls"), "utf8")).toBe(
      "-n /usr/bin/systemctl stop gh-runner.service\n",
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
