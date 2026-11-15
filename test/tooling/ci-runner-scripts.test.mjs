import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  armChecks,
  armRunnerLabel,
  gateRunnerLabel,
  linuxRunnerLabel,
} from "../../scripts/ci/contracts.mjs";

const scripts = path.resolve(import.meta.dirname, "../../scripts/operations/ci-runner");
const asRootInPrivateMounts = (script) => [
  "--unshare-user",
  "--uid",
  "0",
  "--gid",
  "0",
  "--cap-add",
  "ALL",
  "--dev-bind",
  "/",
  "/",
  "/bin/bash",
  "-c",
  script,
];
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const sandbox = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ci-runner-scripts-"));
  directories.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const fake = (name, body) => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/bash\n${body}\n`);
    chmodSync(file, 0o755);
  };
  const run = (script, args = [], { inheritPath = true, input = "", env = {} } = {}) =>
    spawnSync("/bin/bash", [path.join(scripts, script), ...args], {
      encoding: "utf8",
      input,
      env: { PATH: inheritPath ? `${bin}:${process.env.PATH}` : bin, HOME: root, ...env },
    });
  const calls = (name = "calls") => {
    const file = path.join(root, name);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  const record = (name) => `printf '${name} %s\\n' "$*" >> "${root}/calls"`;
  return { root, fake, run, calls, record };
};

const fakeRunnerAccounts = (box, present) => {
  const uids = { "gh-runner": 996, "gh-runner-2": 995, "gh-runner-gate": 994, "gh-runner-3": 993 };
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
    box.fake("pgrep", `printf 'pgrep\\n' >> "${box.root}/pgrep-calls"\n${pgrep}`);
    box.fake("sleep", "exit 0");
    box.fake("sudo", `printf '%s\\n' "$*" >> "${box.root}/sudo-calls"`);
    box.fake(
      "systemctl",
      `[ "$1" = is-enabled ] && [ -e "${box.root}/enabled-$3" ] && exit 0\nexit 3`,
    );
    return box;
  };

  it("refuses to stop anything unless the Mac removed the label first", () => {
    const { run, calls } = pauseBox();
    for (const args of [[], ["3600"], ["--labels-removed-later"]]) {
      const result = run("runner-pause.sh", args);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain("pause-runners.sh");
    }
    expect(calls("sudo-calls")).toBe("");
    expect(calls("pgrep-calls")).toBe("");
  });

  it.each(["abc", "0", "181", "-5", "1.5", "0090"])(
    "rejects quiet window %s before touching the service",
    (quiet) => {
      const { run, calls } = pauseBox();
      const result = run("runner-pause.sh", ["--labels-removed", quiet]);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain("1-180");
      expect(calls("sudo-calls")).toBe("");
    },
  );

  it("prints the state of each installed runner service", () => {
    const box = pauseBox({ accounts: ["gh-runner"] });
    box.fake("systemctl", '[ "$1" = is-active ] && echo inactive && exit 3');
    const result = box.run("runner-pause.sh", ["--status"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("gh-runner.service=inactive\n");
    expect(box.calls("sudo-calls")).toBe("");
  });

  it("lists only the runners that are registered on this host", () => {
    const both = pauseBox();
    for (const unit of ["gh-runner.service", "gh-runner-2.service"])
      writeFileSync(path.join(both.root, `enabled-${unit}`), "");
    expect(both.run("runner-pause.sh", ["--list"]).stdout).toBe("ci-vps-1\nci-vps-2\n");
    const installedNotRegistered = pauseBox();
    writeFileSync(path.join(installedNotRegistered.root, "enabled-gh-runner.service"), "");
    expect(installedNotRegistered.run("runner-pause.sh", ["--list"]).stdout).toBe("ci-vps-1\n");
  });

  it("stops both runners only after watching them idle for the whole quiet window", () => {
    const { run, calls } = pauseBox();
    const result = run("runner-pause.sh", ["--labels-removed", "30"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RUNNER_PAUSED");
    expect(result.stdout).toContain("quiet=30s");
    expect(calls("pgrep-calls").split("\n").filter(Boolean)).toHaveLength(8);
    expect(calls("sudo-calls")).toBe(
      "-n /usr/bin/systemctl stop gh-runner.service\n-n /usr/bin/systemctl stop gh-runner-2.service\n",
    );
  });

  it("stops only the first runner when the second account does not exist", () => {
    const { run, calls } = pauseBox({ accounts: ["gh-runner"] });
    const result = run("runner-pause.sh", ["--labels-removed"]);
    expect(result.status).toBe(0);
    expect(calls("sudo-calls")).toBe("-n /usr/bin/systemctl stop gh-runner.service\n");
  });

  it("lists and stops the gate runner together with the two check runners", () => {
    const accounts = ["gh-runner", "gh-runner-2", "gh-runner-gate"];
    const listed = pauseBox({ accounts });
    for (const unit of ["gh-runner.service", "gh-runner-2.service", "gh-runner-gate.service"])
      writeFileSync(path.join(listed.root, `enabled-${unit}`), "");
    expect(listed.run("runner-pause.sh", ["--list"]).stdout).toBe(
      "ci-vps-1\nci-vps-2\nci-vps-gate\n",
    );
    const stopped = pauseBox({ accounts });
    expect(stopped.run("runner-pause.sh", ["--labels-removed", "10"]).status).toBe(0);
    expect(stopped.calls("sudo-calls")).toBe(
      "-n /usr/bin/systemctl stop gh-runner.service\n-n /usr/bin/systemctl stop gh-runner-2.service\n-n /usr/bin/systemctl stop gh-runner-gate.service\n",
    );
  });

  it("leaves every runner running when the gate runner is still writing a verdict", () => {
    const { run, calls } = pauseBox({
      accounts: ["gh-runner", "gh-runner-2", "gh-runner-gate"],
      pgrep: '[ "$2" = gh-runner-gate ] && exit 0\nexit 1',
    });
    const result = run("runner-pause.sh", ["--labels-removed", "30"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("RUNNER_STILL_BUSY gh-runner-gate");
    expect(calls("sudo-calls")).toBe("");
  });

  it("leaves both runners running when a job shows up during the quiet window", () => {
    const { run, calls } = pauseBox({
      pgrep: `[ "$(grep -c . "${"$"}{HOME}/pgrep-calls")" -ge 5 ] && [ "$2" = gh-runner-2 ] && exit 0\nexit 1`,
    });
    const result = run("runner-pause.sh", ["--labels-removed", "90"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("RUNNER_STILL_BUSY gh-runner-2");
    expect(calls("sudo-calls")).toBe("");
  });

  it("does not stop anything when pgrep itself fails", () => {
    const { run, calls } = pauseBox({ pgrep: "exit 3" });
    const result = run("runner-pause.sh", ["--labels-removed"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("RUNNER_PAUSE_FAILED");
    expect(calls("sudo-calls")).toBe("");
  });
});

const macBox = ({
  runners = [
    [11, "ci-vps-1"],
    [12, "ci-vps-2"],
  ],
  vpsNames = ["ci-vps-1", "ci-vps-2"],
  labelled = true,
} = {}) => {
  const box = sandbox();
  const R = box.root;
  const ownLabel = (name) =>
    name === "ci-vps-gate" ? "ci-vps-gate" : name.startsWith("ci-arm") ? "ci-arm" : "ci-vps";
  const labels = (name, extra) =>
    ["self-hosted", "Linux", "X64", ...(extra ?? (labelled ? [ownLabel(name)] : []))].join(",");
  writeFileSync(
    path.join(R, "runners.tsv"),
    runners
      .map(([id, name, extra]) => `${id}\t${name}\toffline\tfalse\t${labels(name, extra)}\n`)
      .join(""),
  );
  writeFileSync(path.join(R, "vps-names"), vpsNames.map((name) => `${name}\n`).join(""));
  const relabel = (on) =>
    `awk -F'\\t' -v OFS='\\t' -v id="$id" -v label="$label" -v on=${on ? 1 : 0} '$1 == id { n = split($5, have, ","); kept = ""; for (i = 1; i <= n; i++) if (have[i] != label) kept = kept (kept == "" ? "" : ",") have[i]; $5 = on ? kept "," label : kept } 1' "${R}/runners.tsv" > "${R}/t" && mv "${R}/t" "${R}/runners.tsv"`;
  box.fake(
    "gh",
    [
      `printf 'gh %s\\n' "$*" >> "${R}/calls"`,
      'args="$*"',
      "if [[ $args == */labels* ]]; then",
      `  id=$(sed -E 's#.*/runners/([0-9]+)/labels.*#\\1#' <<< "$args")`,
      '  if [[ $args == *"-X DELETE"* ]]; then',
      `    label=$(sed -E 's#.*/labels/([^ ]+).*#\\1#' <<< "$args")`,
      `    [ -e "${R}/interrupt-delete-$id" ] && { kill -TERM $PPID; exit 1; }`,
      `    [ -e "${R}/fail-delete-$id" ] && exit 1`,
      `    [ -e "${R}/ignore-delete-$id" ] && exit 0`,
      `    ${relabel(false)}`,
      `    [ -e "${R}/interrupt-after-delete-$id" ] && kill -TERM $PPID`,
      "  else",
      `    label=$(sed -E 's#.*labels\\[\\]=([^ ]+).*#\\1#' <<< "$args")`,
      `    [ -e "${R}/fail-add-$id" ] && exit 1`,
      `    ${relabel(true)}`,
      `    [ -e "${R}/interrupt-after-add-$id" ] && kill -TERM $PPID`,
      "  fi",
      "  exit 0",
      "fi",
      `n=$(( $(cat "${R}/list-count" 2> /dev/null || echo 0) + 1 )); echo $n > "${R}/list-count"`,
      `f=$(cat "${R}/fail-list-from" 2> /dev/null || echo 0); [ "$f" != 0 ] && [ "$n" -ge "$f" ] && exit 1`,
      `[ "$n" = "$(cat "${R}/partial-list-at" 2> /dev/null)" ] && { head -1 "${R}/runners.tsv" | sed 's/ci-vps$/X/'; exit 1; }`,
      `b=$(cat "${R}/busy-until" 2> /dev/null || echo 0)`,
      `o=$(cat "${R}/online-from" 2> /dev/null || echo 0)`,
      `awk -F'\\t' -v OFS='\\t' -v n=$n -v b=$b -v o=$o '{ $4 = (n < b) ? "true" : "false"; $3 = (n >= o) ? "online" : "offline"; print }' "${R}/runners.tsv"`,
    ].join("\n"),
  );
  box.fake(
    "scp",
    `printf 'upload %s\\n' "$*" >> "${R}/calls"\n[ -e "${R}/scp-fail" ] && exit 1\nexit 0`,
  );
  box.fake(
    "ssh",
    [
      "for command; do :; done",
      `printf 'ssh %s\\n' "$command" >> "${R}/calls"`,
      'case "$command" in',
      `  *--list) [ -e "${R}/list-fail" ] && exit 1; cat "${R}/vps-names" ;;`,
      `  *--status) cat "${R}/service-states" 2> /dev/null || printf 'gh-runner.service=active\\ngh-runner-2.service=active\\n' ;;`,
      "  *--labels-removed*)",
      `    code=$(head -1 "${R}/pause-results" 2> /dev/null || echo 0)`,
      `    sed -i '1d' "${R}/pause-results" 2> /dev/null`,
      '    [ "$code" = 0 ] && echo RUNNER_PAUSED || echo RUNNER_STILL_BUSY',
      '    exit "$code" ;;',
      `  *runner-resume.sh) [ -e "${R}/resume-fail" ] && exit 1; echo RUNNER_RESUMED ;;`,
      "esac",
    ].join("\n"),
  );
  box.fake(
    "sleep",
    `[ -e "${R}/interrupt-sleep" ] && { rm -f "${R}/interrupt-sleep"; kill -TERM $PPID; }\nexit 0`,
  );
  const set = (name, value) => writeFileSync(path.join(R, name), `${value}`);
  const late = () =>
    box.fake(
      "date",
      `n=$(( $(cat "${R}/date-count" 2> /dev/null || echo 0) + 1 )); echo $n > "${R}/date-count"; [ $n -le 1 ] && echo 1000 || echo 99999999`,
    );
  const mac = (script, args = [], env = {}) =>
    spawnSync("/bin/bash", [path.join(scripts, script), ...args], {
      encoding: "utf8",
      env: {
        PATH: `${box.root}/bin:${process.env.PATH}`,
        HOME: R,
        RUNNER_LOCK_DIR: path.join(R, "lock"),
        RUNNER_POLL_SECONDS: "0",
        ...env,
      },
    });
  const labelState = () =>
    Object.fromEntries(
      readFileSync(path.join(R, "runners.tsv"), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("\t"))
        .map(([, name, , , l]) => [name, l.split(",").includes("ci-vps")]),
    );
  const managedLabels = () =>
    Object.fromEntries(
      readFileSync(path.join(R, "runners.tsv"), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("\t"))
        .map(([, name, , , l]) => [name, l.split(",").filter((label) => label.startsWith("ci-"))]),
    );
  const lines = () => box.calls().split("\n").filter(Boolean);
  return { ...box, set, late, mac, labelState, managedLabels, lines };
};

describe("[HR-11] runner 名字和标签", () => {
  it("注册用的标签和主机就是 CI 工作流要的 ci-vps", () => {
    const runners = readFileSync(path.join(scripts, "runners.sh"), "utf8");
    expect(runners).toContain(`RUNNER_CHECK_LABEL=${linuxRunnerLabel}\n`);
    expect(runners).toContain("RUNNER_HOST=ci-vps\n");
    expect(runners).toContain("RUNNER_NAME=ci-vps-1\n");
    expect(runners).toContain("RUNNER_NAME=ci-vps-2\n");
    expect(readFileSync(path.join(scripts, "register-runner.sh"), "utf8")).toContain(
      '--labels "$RUNNER_LABEL"',
    );
    expect(
      shell("runner_select 1; echo $RUNNER_LABEL; runner_select 2; echo $RUNNER_LABEL").stdout,
    ).toBe(`${linuxRunnerLabel}\n${linuxRunnerLabel}\n`);
  });
});

describe("pause-runners.sh", () => {
  it("removes the label from both runners before asking the VPS to stop them", () => {
    const box = macBox();
    const result = box.mac("pause-runners.sh");
    expect(result.stdout).toContain("RUNNER_PAUSED labels=removed services=stopped");
    expect(result.stdout).toContain("24 hours");
    expect(result.status).toBe(0);
    expect(box.labelState()).toEqual({ "ci-vps-1": false, "ci-vps-2": false });
    const order = box.lines();
    const stop = order.findIndex((line) => line.includes("--labels-removed 90"));
    const deletes = order.filter((line) => line.includes("-X DELETE"));
    expect(deletes).toHaveLength(2);
    expect(order.findIndex((line) => line.includes("-X DELETE"))).toBeLessThan(stop);
    expect(order.filter((line) => line.startsWith("upload "))).toHaveLength(3);
    expect(order.some((line) => line.includes("-X POST"))).toBe(false);
    const remote = order.filter((line) => line.startsWith("ssh "));
    expect(remote.length).toBeGreaterThan(0);
    for (const line of remote) expect(line).toContain('[ "$(hostname)" = ci-vps ] ||');
  });

  it("waits until GitHub reports both runners idle before asking the VPS to stop", () => {
    const box = macBox();
    box.set("busy-until", 5);
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(0);
    const order = box.lines();
    const stop = order.findIndex((line) => line.includes("--labels-removed"));
    const listsBefore = order.slice(0, stop).filter((line) => line.endsWith("@tsv"));
    expect(listsBefore.length).toBeGreaterThanOrEqual(5);
    const waiting = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("RUNNER_PAUSE_WAITING"));
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toContain("for: ci-vps-1 ci-vps-2;");
  });

  it("says nothing about waiting when the runners are idle from the start", () => {
    const result = macBox().mac("pause-runners.sh");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("RUNNER_PAUSE_WAITING");
  });

  it("asks the VPS again when a job was still finishing there", () => {
    const box = macBox();
    box.set("pause-results", "2\n2\n0\n");
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(0);
    expect(box.lines().filter((line) => line.includes("--labels-removed"))).toHaveLength(3);
  });

  it("works with only the first runner installed", () => {
    const box = macBox({ runners: [[11, "ci-vps-1"]], vpsNames: ["ci-vps-1"] });
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(0);
    expect(box.lines().filter((line) => line.includes("-X DELETE"))).toHaveLength(1);
  });

  it("changes nothing when the VPS has a runner GitHub does not know", () => {
    const box = macBox({ runners: [[11, "ci-vps-1"]] });
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("RUNNER_PAUSE_FAILED GitHub has 0 runners named ci-vps-2");
    expect(
      box.lines().some((line) => line.includes("-X") || line.includes("--labels-removed")),
    ).toBe(false);
  });

  it("changes nothing when GitHub has a ci-vps runner that is not on the VPS", () => {
    const box = macBox({ vpsNames: ["ci-vps-1"] });
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ci-vps-2 carries ci-vps but is not installed");
    expect(box.lines().some((line) => line.includes("-X"))).toBe(false);
  });

  it("puts the label back and leaves the VPS alone when one removal fails", () => {
    const box = macBox();
    box.set("fail-delete-12", "");
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "RUNNER_PAUSE_FAILED a runner label is still on: ci-vps-2; put back on: 11",
    );
    expect(box.labelState()).toEqual({ "ci-vps-1": true, "ci-vps-2": true });
    expect(box.lines().some((line) => line.includes("--labels-removed"))).toBe(false);
  });

  it("does not trust a removal that GitHub says worked but did not happen", () => {
    const box = macBox();
    box.set("ignore-delete-11", "");
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("still on: ci-vps-1");
    expect(box.lines().some((line) => line.includes("--labels-removed"))).toBe(false);
  });

  it("keeps services running and labels removed when the jobs outlast the deadline", () => {
    const box = macBox();
    box.set("busy-until", 9999);
    box.late();
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      "RUNNER_PAUSE_INCOMPLETE labels=removed services=gh-runner.service=active gh-runner-2.service=active busy: ci-vps-1 ci-vps-2",
    );
    expect(box.labelState()).toEqual({ "ci-vps-1": false, "ci-vps-2": false });
    expect(
      box.lines().some((line) => line.includes("--labels-removed") || line.includes("-X POST")),
    ).toBe(false);
  });

  it("keeps labels removed and reports each service when the VPS stops only one of them", () => {
    const box = macBox();
    box.set("pause-results", "1\n");
    box.set("service-states", "gh-runner.service=inactive\ngh-runner-2.service=active\n");
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "RUNNER_PAUSE_INCOMPLETE labels=removed services=gh-runner.service=inactive gh-runner-2.service=active",
    );
    expect(box.labelState()).toEqual({ "ci-vps-1": false, "ci-vps-2": false });
    expect(box.lines().some((line) => line.includes("-X POST"))).toBe(false);
  });

  it("puts the labels back when interrupted while removing them", () => {
    const box = macBox();
    box.set("interrupt-delete-12", "");
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(130);
    expect(result.stdout).toContain(
      "RUNNER_PAUSE_FAILED interrupted while removing labels; put back on: 11",
    );
    expect(box.labelState()).toEqual({ "ci-vps-1": true, "ci-vps-2": true });
    expect(box.lines().some((line) => line.includes("--labels-removed"))).toBe(false);
    expect(existsSync(path.join(box.root, "lock"))).toBe(false);
  });

  it("puts back a label whose removal went through just before the interruption", () => {
    const box = macBox();
    box.set("interrupt-after-delete-11", "");
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(130);
    expect(result.stdout).toContain("put back on: 11");
    expect(box.labelState()).toEqual({ "ci-vps-1": true, "ci-vps-2": true });
    expect(box.lines().some((line) => line.includes("--labels-removed"))).toBe(false);
  });

  it("treats an incomplete re-read of GitHub as not removed and puts the labels back", () => {
    const box = macBox();
    box.set("partial-list-at", 2);
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("still on: ci-vps-1(could not read) ci-vps-2(could not read)");
    expect(result.stdout).toContain("put back on: 11 12");
    expect(box.labelState()).toEqual({ "ci-vps-1": true, "ci-vps-2": true });
    expect(box.lines().some((line) => line.includes("--labels-removed"))).toBe(false);
  });

  it("says GitHub could not be read instead of calling the runners busy", () => {
    const box = macBox();
    box.set("fail-list-from", 3);
    box.late();
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("busy: (could not read GitHub)");
    expect(box.labelState()).toEqual({ "ci-vps-1": false, "ci-vps-2": false });
  });

  it("reports labels removed and the service states when interrupted while waiting", () => {
    const box = macBox();
    box.set("busy-until", 9999);
    box.set("interrupt-sleep", "");
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(130);
    expect(result.stdout).toContain(
      "RUNNER_PAUSE_INCOMPLETE interrupted labels=removed services=gh-runner.service=active gh-runner-2.service=active",
    );
    expect(box.labelState()).toEqual({ "ci-vps-1": false, "ci-vps-2": false });
  });

  it("says labels and services were untouched when the runners do not match", () => {
    const result = macBox({ runners: [[11, "ci-vps-1"]] }).mac("pause-runners.sh");
    expect(result.stdout).toContain("labels and services untouched");
    expect(result.stdout).not.toContain("nothing changed");
  });

  it("refuses to run while another pause or resume holds the lock", () => {
    const box = macBox();
    mkdirSync(path.join(box.root, "lock"));
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(75);
    expect(result.stdout).toContain("RUNNER_LOCKED");
    expect(box.calls()).toBe("");
    expect(existsSync(path.join(box.root, "lock"))).toBe(true);
  });

  it("releases the lock when it finishes", () => {
    const box = macBox();
    expect(box.mac("pause-runners.sh").status).toBe(0);
    expect(existsSync(path.join(box.root, "lock"))).toBe(false);
  });
});

describe("resume-runners.sh", () => {
  const startsServices = (line) => line.startsWith("ssh ") && line.includes("runner-resume.sh");

  it("puts the label back before starting the services, then waits for GitHub to see them online", () => {
    const box = macBox({ labelled: false });
    box.set("online-from", 4);
    const result = box.mac("resume-runners.sh");
    expect(result.stdout).toContain("RUNNER_RESUMED labels=restored");
    expect(result.status).toBe(0);
    expect(box.labelState()).toEqual({ "ci-vps-1": true, "ci-vps-2": true });
    const order = box.lines();
    const start = order.findIndex(startsServices);
    expect(start).toBeGreaterThan(-1);
    const adds = order
      .map((line, index) => (line.includes("-X POST") ? index : -1))
      .filter((index) => index >= 0);
    expect(adds).toHaveLength(2);
    expect(Math.max(...adds)).toBeLessThan(start);
    expect(
      order.slice(start).filter((line) => line.endsWith("@tsv")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("changes nothing when the runners on the VPS and GitHub do not match", () => {
    const box = macBox({ labelled: false, runners: [[11, "ci-vps-1"]] });
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("RUNNER_RESUME_FAILED GitHub has 0 runners named ci-vps-2");
    expect(box.lines().some((line) => startsServices(line) || line.includes("-X POST"))).toBe(
      false,
    );
  });

  it("changes nothing when GitHub has two runners with the same name", () => {
    const box = macBox({
      labelled: false,
      runners: [
        [11, "ci-vps-1"],
        [12, "ci-vps-2"],
        [13, "ci-vps-2"],
      ],
    });
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("GitHub has 2 runners named ci-vps-2");
    expect(box.lines().some((line) => line.includes("-X POST"))).toBe(false);
  });

  it("does not start the services when a label could not be put back", () => {
    const box = macBox({ labelled: false });
    box.set("fail-add-12", "");
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "RUNNER_RESUME_INCOMPLETE labels: ci-vps-1=on ci-vps-2=off; services not started",
    );
    expect(box.labelState()).toEqual({ "ci-vps-1": true, "ci-vps-2": false });
    expect(box.lines().some(startsServices)).toBe(false);
  });

  it("does not start the services when the labels cannot be read back", () => {
    const box = macBox({ labelled: false });
    box.set("fail-list-from", 2);
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ci-vps-1=unread ci-vps-2=unread; services not started");
    expect(box.lines().some(startsServices)).toBe(false);
  });

  it("keeps the labels on and reports each service when the services do not start", () => {
    const box = macBox({ labelled: false });
    box.set("resume-fail", "");
    box.set("service-states", "gh-runner.service=active\ngh-runner-2.service=failed\n");
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "RUNNER_RESUME_FAILED services=gh-runner.service=active gh-runner-2.service=failed labels=restored",
    );
    expect(box.labelState()).toEqual({ "ci-vps-1": true, "ci-vps-2": true });
  });

  it("keeps the labels on when the runners never come online", () => {
    const box = macBox({ labelled: false });
    box.set("online-from", 9999);
    box.late();
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      "RUNNER_RESUME_INCOMPLETE services=gh-runner.service=active gh-runner-2.service=active labels=restored offline: ci-vps-1 ci-vps-2",
    );
    expect(box.labelState()).toEqual({ "ci-vps-1": true, "ci-vps-2": true });
  });

  it("reports services and each label when interrupted while putting labels back", () => {
    const box = macBox({ labelled: false });
    box.set("interrupt-after-add-11", "");
    box.set("service-states", "gh-runner.service=inactive\ngh-runner-2.service=inactive\n");
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(130);
    expect(result.stdout).toContain(
      "RUNNER_RESUME_INCOMPLETE interrupted services=gh-runner.service=inactive gh-runner-2.service=inactive labels: ci-vps-1=on ci-vps-2=off",
    );
    expect(box.lines().some(startsServices)).toBe(false);
  });

  it("reports services and labels when interrupted while waiting for the runners to come online", () => {
    const box = macBox({ labelled: false });
    box.set("online-from", 9999);
    box.set("interrupt-sleep", "");
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(130);
    expect(result.stdout).toContain(
      "RUNNER_RESUME_INCOMPLETE interrupted services=gh-runner.service=active gh-runner-2.service=active labels: ci-vps-1=on ci-vps-2=on",
    );
  });

  it("says GitHub could not be read instead of calling the runners offline", () => {
    const box = macBox({ labelled: false });
    box.set("fail-list-from", 3);
    box.late();
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("offline: (could not read GitHub)");
  });

  it("does not add a label that is already there", () => {
    const box = macBox({ labelled: true });
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(0);
    expect(box.lines().some((line) => line.includes("-X POST"))).toBe(false);
    expect(box.lines().some(startsServices)).toBe(true);
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
  it("skips cleaning work directories and reports failure when pgrep itself fails", () => {
    const box = sandbox();
    fakeRunnerAccounts(box, ["gh-runner", "gh-runner-2"]);
    box.fake("pgrep", "exit 3");
    box.fake("find", `${box.record("find")}\nexit 0`);
    const result = box.run("clean-old.sh");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CLEAN_SKIPPED");
    expect(box.calls()).not.toContain("_work");
    expect(box.calls()).not.toContain("_diag");
  });

  it("removes only run directories in the runner share that are more than six hours old", () => {
    const share = mkdtempSync(path.join(os.tmpdir(), "ci-runner-share-"));
    directories.push(share);
    for (const name of ["41-1", "42-1"])
      mkdirSync(path.join(share, name, "build-linux-x64"), { recursive: true });
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(path.join(share, "41-1"), old, old);
    const box = sandbox();
    fakeRunnerAccounts(box, []);
    const copy = path.join(box.root, "scripts");
    mkdirSync(copy);
    copyFileSync(path.join(scripts, "clean-old.sh"), path.join(copy, "clean-old.sh"));
    writeFileSync(
      path.join(copy, "runners.sh"),
      readFileSync(path.join(scripts, "runners.sh"), "utf8").replace(
        "RUNNER_SHARE_ROOT=/srv/gh-runner-share",
        `RUNNER_SHARE_ROOT=${share}`,
      ),
    );
    const result = spawnSync("/bin/bash", [path.join(copy, "clean-old.sh")], {
      encoding: "utf8",
      env: { PATH: `${box.root}/bin:${process.env.PATH}`, HOME: box.root },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readdirSync(share)).toEqual(["42-1"]);
  });

  it("runs every hour so leftover run files never pile up for long", () => {
    const timer = unitSettings(readFileSync(path.join(scripts, "gh-runner-clean.timer"), "utf8"));
    expect(timer.OnCalendar).toBe("hourly");
    expect(
      shell('echo "$RUNNER_SHARE_ROOT $RUNNER_SHARE_GROUP $RUNNER_SHARE_KEEP_MINUTES"').stdout,
    ).toBe("/srv/gh-runner-share gh-ci-share 360\n");
  });
});

describe("runner units and shared limits", () => {
  const template = path.join(scripts, "gh-runner.service.in");
  const render = (id) => shell(`render_runner_unit ${id} "${template}"`);
  const slice = () => unitSettings(readFileSync(path.join(scripts, "gh-runners.slice"), "utf8"));

  const gateSlice = () => unitSettings(readFileSync(path.join(scripts, "ghgate.slice"), "utf8"));

  it("gives the three check runners all cores and 16 GB together with default priority on a CI-only host", () => {
    expect(slice()).toMatchObject({
      MemoryHigh: "15G",
      MemoryMax: "16G",
      MemorySwapMax: "0",
      TasksMax: "6144",
    });
    for (const key of ["CPUQuota", "CPUWeight", "IOWeight"]) {
      expect(slice()).not.toHaveProperty(key);
    }
    expect(bytes(slice().MemoryHigh)).toBeLessThan(bytes(slice().MemoryMax));
  });

  it("reserves 2 GB and allows up to 4 GB for the gate runner outside the check runners' pool, and both pools fit in the 22 GB host", () => {
    expect(gateSlice()).toMatchObject({
      MemoryMin: "2G",
      MemoryHigh: "3G",
      MemoryMax: "4G",
      MemorySwapMax: "0",
      TasksMax: "1024",
    });
    expect(bytes(slice().MemoryMax) + bytes(gateSlice().MemoryMax)).toBeLessThanOrEqual(
      bytes("20G"),
    );
    const unit = unitSettings(render(3).stdout);
    expect(unit).toMatchObject({
      Slice: "ghgate.slice",
      User: "gh-runner-gate",
      Group: "gh-runner-gate",
      WorkingDirectory: "/srv/gh-runner-gate/runner",
      MemoryMin: "2G",
      MemoryHigh: "3G",
      MemoryMax: "4G",
      MemorySwapMax: "0",
      TasksMax: "1024",
      ReadWritePaths:
        "/srv/gh-runner-gate/runner /srv/gh-runner-gate/home /srv/gh-runner-gate/logs /srv/gh-runner-share",
      SupplementaryGroups: "gh-ci-share",
    });
    expect(unit.Description).toContain("ci-vps-gate");
    expect(render(3).stdout).not.toContain("@");
  });

  it("the gate slice name has no dash, so systemd does not nest it under a parent slice without a reservation", () => {
    expect(shell("runner_select 3; echo $RUNNER_SLICE").stdout.trim()).toMatch(/^[a-z]+\.slice$/);
  });

  it.each([
    [1, ["/srv/gh-runner-2", "/srv/gh-runner-3", "/srv/gh-runner-gate"]],
    [2, ["/srv/gh-runner", "/srv/gh-runner-3", "/srv/gh-runner-gate"]],
    [3, ["/srv/gh-runner", "/srv/gh-runner-2", "/srv/gh-runner-3"]],
    [6, ["/srv/gh-runner", "/srv/gh-runner-2", "/srv/gh-runner-gate"]],
  ])("runner %s cannot see the directories of the other three runners", (id, others) => {
    const hidden = unitSettings(render(id).stdout).InaccessiblePaths.split(" ");
    for (const other of others) expect(hidden).toContain(`-${other}`);
    expect(hidden).toHaveLength(5);
  });

  it.each([
    [1, "gh-runner", "/srv/gh-runner", "/srv/gh-runner-2", "ci-vps-1"],
    [2, "gh-runner-2", "/srv/gh-runner-2", "/srv/gh-runner", "ci-vps-2"],
    [6, "gh-runner-3", "/srv/gh-runner-3", "/srv/gh-runner", "ci-vps-3"],
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
        MemoryMin: "0",
        MemoryHigh: "14G",
        MemoryMax: "15G",
        MemorySwapMax: "0",
        TasksMax: "2048",
        ProtectProc: "invisible",
        ReadWritePaths: `${root}/runner ${root}/home ${root}/logs /srv/gh-runner-share`,
        SupplementaryGroups: "gh-ci-share",
      });
      expect(result.stdout).toContain("Environment=HIMAWARI_CI_SHARE=/srv/gh-runner-share\n");
      expect(unit.Description).toContain(name);
      expect(unit.InaccessiblePaths.split(" ")).toEqual(
        expect.arrayContaining(["-/var/run/docker.sock", `-${other}`]),
      );
      expect(bytes(unit.MemoryMax)).toBeLessThanOrEqual(bytes(slice().MemoryMax));
      for (const key of ["CPUQuota", "CPUWeight", "IOWeight", "Nice"]) {
        expect(unit).not.toHaveProperty(key);
      }
    },
  );

  it.each([1, 2, 3])(
    "runner %s puts no read-only mounts under /proc, so the job sandbox can mount a fresh /proc",
    (id) => {
      const result = render(id);
      expect(result.status).toBe(0);
      const unit = unitSettings(result.stdout);
      for (const key of ["ProtectKernelTunables", "ProtectKernelLogs"]) {
        expect(unit).not.toHaveProperty(key);
      }
      for (const key of ["ReadOnlyPaths", "InaccessiblePaths", "TemporaryFileSystem"]) {
        for (const path of (unit[key] ?? "").split(" ")) {
          expect(path.replace(/^[-+]/, "")).not.toMatch(/^\/proc(\/|$)/);
        }
      }
    },
  );

  it("gives the three check runners the same hardening apart from their own paths and names", () => {
    const normalize = (id, name, root) =>
      render(id)
        .stdout.replaceAll(name, "NAME")
        .replace(new RegExp(`${root}(?![-\\w])`, "g"), "ROOT")
        .replace(/^(User|Group|InaccessiblePaths)=.*\n/gm, "");
    const first = normalize(1, "ci-vps-1", "/srv/gh-runner");
    expect(normalize(2, "ci-vps-2", "/srv/gh-runner-2")).toBe(first);
    expect(normalize(6, "ci-vps-3", "/srv/gh-runner-3")).toBe(first);
    expect(first).toContain("NoNewPrivileges=yes");
  });

  it("gives the gate runner the same hardening as a check runner apart from its pool, paths and names", () => {
    const strip = (text) =>
      text
        .split("\n")
        .filter(
          (line) =>
            !/^(Description|Slice|User|Group|WorkingDirectory|ExecStart|Environment|MemoryMin|MemoryHigh|MemoryMax|TasksMax|ReadWritePaths|InaccessiblePaths)=/.test(
              line,
            ),
        )
        .join("\n");
    expect(strip(render(3).stdout)).toBe(strip(render(1).stdout));
    expect(strip(render(1).stdout)).toContain("NoNewPrivileges=yes");
  });

  it("rejects an unknown runner number", () => {
    expect(render(4).status).not.toBe(0);
    expect(render(0).status).not.toBe(0);
  });

  it("firewall rules apply to every runner account", () => {
    const result = shell('runner_firewall_rules "996, 995" "22,8080"');
    const ruleLines = result.stdout.split("\n").filter((line) => line.includes("reject"));
    expect(ruleLines).toHaveLength(3);
    for (const line of ruleLines) expect(line).toContain("meta skuid { 996, 995 }");
    expect(result.stdout).toContain(
      "meta skuid { 996, 995 } fib daddr type local tcp dport { 22,8080 } reject",
    );
  });

  it("ubuntu may only start, stop and restart the runner services", () => {
    const result = shell("runner_sudoers_line 1 2");
    expect(result.stdout).toBe(
      "ubuntu ALL=(root) NOPASSWD: " +
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
      expect(result.stderr).toContain("only runs on ci-vps");
      expect(existsSync(path.join(root, "id-calls"))).toBe(false);
    },
  );

  it.each(["install-runner.sh", "register-runner.sh", "uninstall-runner.sh"])(
    "%s passes the host check on ci-vps and still requires root",
    (script) => {
      const { fake, run } = sandbox();
      fake("hostname", "echo ci-vps");
      fake("id", "echo 1000");
      const result = run(script);
      expect(result.status).toBe(65);
      expect(result.stderr).toContain("run it with sudo");
    },
  );

  it("register-runner.sh names a missing python3 before asking for the token", () => {
    const { fake, run } = sandbox();
    fake("hostname", "echo ci-vps");
    const result = run("register-runner.sh", [], { inheritPath: false });
    expect(result.status).toBe(66);
    expect(result.stderr).toContain("missing python3");
  });
});

describe("register-runner.sh arguments", () => {
  const registerBox = () => {
    const box = sandbox();
    box.fake("hostname", "echo ci-vps");
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

  it("accepts the gate runner as number 3 and nothing above it", () => {
    const { run } = registerBox();
    expect(run("register-runner.sh", ["3"]).stderr).toContain("no registration token");
    expect(run("register-runner.sh", ["4"], { input: "token\n" }).stderr).toContain("usage");
  });
});

describe("install-runner.sh", () => {
  it("refuses to change anything while a runner service is active", () => {
    const box = sandbox();
    box.fake("hostname", "echo ci-vps");
    fakeRunnerAccounts(box, ["gh-runner"]);
    for (const tool of ["nft", "visudo", "useradd", "sha256sum", "curl", "ss", "python3"])
      box.fake(tool, `${box.record(tool)}\nexit 0`);
    box.fake("systemctl", `${box.record("systemctl")}\n[ "$1" = is-active ] && exit 0\nexit 0`);
    box.fake("install", `${box.record("install")}\nexit 0`);
    box.fake("sudo", `${box.record("sudo")}\nexit 0`);
    const result = box.run("install-runner.sh");
    expect(result.status).toBe(70);
    expect(result.stderr).toContain("pause-runners.sh");
    expect(box.calls()).not.toMatch(/^(useradd|install|nft|sudo) /m);
  });
});

describe("install-runner.sh rollback", () => {
  const helper = (box, body) =>
    spawnSync("/bin/bash", ["-c", `set -euo pipefail\nsource "${scripts}/runners.sh"\n${body}`], {
      encoding: "utf8",
      env: { PATH: `${box.root}/bin:${process.env.PATH}`, HOME: box.root },
    });

  it("puts back files that existed and removes files the failed run created", () => {
    const box = sandbox();
    const target = path.join(box.root, "target");
    const backup = path.join(box.root, "backup");
    mkdirSync(path.join(target, "rules"), { recursive: true });
    mkdirSync(backup);
    writeFileSync(path.join(target, "unit"), "old unit\n");
    writeFileSync(path.join(target, "rules", "nft.rules"), "old rules\n");
    const paths = ["unit", "rules", "new-unit", "new-dir"].map((name) => path.join(target, name));
    const result = helper(
      box,
      [
        `backup_install_paths "${backup}" ${paths.join(" ")}`,
        `echo new > "${target}/unit"`,
        `echo new > "${target}/rules/nft.rules"`,
        `echo extra > "${target}/rules/extra"`,
        `echo new > "${target}/new-unit"`,
        `mkdir "${target}/new-dir"`,
        `restore_install_paths "${backup}"`,
      ].join("\n"),
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(target, "unit"), "utf8")).toBe("old unit\n");
    expect(readFileSync(path.join(target, "rules", "nft.rules"), "utf8")).toBe("old rules\n");
    expect(existsSync(path.join(target, "rules", "extra"))).toBe(false);
    expect(existsSync(path.join(target, "new-unit"))).toBe(false);
    expect(existsSync(path.join(target, "new-dir"))).toBe(false);
  });

  it("stops the processes of a created account before deleting it, and deletes its group", () => {
    const box = sandbox();
    for (const name of ["pkill", "userdel", "groupdel"])
      box.fake(name, `${box.record(name)}\nexit 0`);
    box.fake("id", "exit 0");
    box.fake("getent", "exit 0");
    const backup = path.join(box.root, "backup");
    mkdirSync(backup);
    const result = helper(
      box,
      [
        `backup_install_paths "${backup}"`,
        `record_created_account "${backup}" gh-runner-2`,
        `restore_install_paths "${backup}"`,
      ].join("\n"),
    );
    expect(result.status).toBe(0);
    expect(box.calls()).toBe(
      "pkill -KILL -u gh-runner-2\nuserdel gh-runner-2\ngroupdel gh-runner-2\n",
    );
  });

  it("reports RESTORE_INCOMPLETE when a created account cannot be deleted", () => {
    const box = sandbox();
    box.fake("pkill", "exit 1");
    box.fake(
      "userdel",
      "echo 'userdel: user gh-runner-2 is currently used by process 1' >&2; exit 8",
    );
    box.fake("id", "exit 0");
    box.fake("getent", "exit 2");
    const backup = path.join(box.root, "backup");
    mkdirSync(backup);
    const result = helper(
      box,
      [
        `backup_install_paths "${backup}"`,
        `record_created_account "${backup}" gh-runner-2`,
        `restore_install_paths "${backup}" || echo "rc=$?"`,
      ].join("\n"),
    );
    expect(result.stdout).toBe("rc=1\n");
    expect(result.stderr).toContain("RESTORE_INCOMPLETE could not put back: user:gh-runner-2");
  });

  it("removes directories the failed run created under a runner root that already existed", () => {
    const box = sandbox();
    const backup = path.join(box.root, "backup");
    const root = path.join(box.root, "srv");
    mkdirSync(backup);
    mkdirSync(path.join(root, "runner"), { recursive: true });
    writeFileSync(path.join(root, "runner", "config.sh"), "kept\n");
    const result = helper(
      box,
      [
        `backup_install_paths "${backup}"`,
        `record_created_paths "${backup}" "${root}/runner" "${root}/home" "${root}/logs" "${root}"`,
        `mkdir "${root}/home" "${root}/logs"`,
        `restore_install_paths "${backup}"`,
      ].join("\n"),
    );
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(root, "runner", "config.sh"), "utf8")).toBe("kept\n");
    expect(existsSync(path.join(root, "home"))).toBe(false);
    expect(existsSync(path.join(root, "logs"))).toBe(false);
  });

  it("disables only the units the failed run enabled", () => {
    const box = sandbox();
    box.fake(
      "systemctl",
      `${box.record("systemctl")}\n[ "$1" = is-enabled ] && [ "$3" = gh-runner-clean.timer ] && exit 0\n[ "$1" = is-enabled ] && exit 1\nexit 0`,
    );
    const backup = path.join(box.root, "backup");
    mkdirSync(backup);
    const result = helper(
      box,
      [
        `backup_install_paths "${backup}"`,
        `record_newly_enabled_units "${backup}" gh-runner-nft.service gh-runner-clean.timer`,
        `restore_install_paths "${backup}"`,
      ].join("\n"),
    );
    expect(result.status).toBe(0);
    expect(box.calls()).toMatch(/^systemctl disable --now gh-runner-nft.service$/m);
    expect(box.calls()).not.toMatch(/disable --now gh-runner-clean.timer/);
  });

  it("keeps the original file and reports RESTORE_INCOMPLETE when the copy back fails", () => {
    const box = sandbox();
    const target = path.join(box.root, "target");
    const backup = path.join(box.root, "backup");
    mkdirSync(target);
    mkdirSync(backup);
    writeFileSync(path.join(target, "unit"), "old unit\n");
    const result = helper(
      box,
      [
        `backup_install_paths "${backup}" "${target}/unit"`,
        `echo new > "${target}/unit"`,
        `cp() { case "\${@: -1}" in *.restoring) return 1 ;; esac; command cp "$@"; }`,
        `restore_install_paths "${backup}" || echo "rc=$?"`,
      ].join("\n"),
    );
    expect(result.stdout).toBe("rc=1\n");
    expect(result.stderr).toContain(`RESTORE_INCOMPLETE could not put back: ${target}/unit`);
    expect(readFileSync(path.join(target, "unit"), "utf8")).toBe("new\n");
    expect(existsSync(path.join(backup, "1"))).toBe(true);
  });

  it("puts back a symbolic link whose target is missing", () => {
    const box = sandbox();
    const target = path.join(box.root, "target");
    const backup = path.join(box.root, "backup");
    mkdirSync(target);
    mkdirSync(backup);
    symlinkSync("/nonexistent/unit", path.join(target, "unit"));
    const result = helper(
      box,
      [
        `backup_install_paths "${backup}" "${target}/unit"`,
        `rm "${target}/unit"`,
        `echo new > "${target}/unit"`,
        `restore_install_paths "${backup}"`,
      ].join("\n"),
    );
    expect(result.status).toBe(0);
    expect(readlinkSync(path.join(target, "unit"))).toBe("/nonexistent/unit");
  });

  it("names the real reason when the port list is empty or ss fails", () => {
    const box = sandbox();
    fakeRunnerAccounts(box, ["gh-runner"]);
    box.fake("ss", "exit 1");
    const empty = helper(box, 'runner_blocked_ports() { echo ""; }\napply_runner_controls');
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("no local TCP port to block");
    const failed = helper(box, "apply_runner_controls");
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("could not list local listening ports");
  });

  it("keeps ports from the previous rules so a service that is down stays blocked", () => {
    const box = sandbox();
    box.fake(
      "ss",
      "printf '%s\\n' 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*' 'LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*'",
    );
    const previous = path.join(box.root, "nft.rules");
    writeFileSync(
      previous,
      "    meta skuid { 996 } fib daddr type local tcp dport { 22,8080 } reject\n",
    );
    const result = helper(box, `runner_blocked_ports "${previous}"`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("22,8080\n");
  });

  it("returns an empty list instead of failing when only DNS is listening and there are no previous rules", () => {
    const box = sandbox();
    box.fake("ss", "printf '%s\\n' 'LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*'");
    const result = helper(
      box,
      `ports=$(runner_blocked_ports "${box.root}/missing")\necho "ports=[$ports]"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ports=[]\n");
  });
});

describe("install-runner.sh run as root in a private mount namespace", () => {
  const reported = [
    "/etc/systemd/system/gh-runner.service",
    "/etc/systemd/system/gh-runner-2.service",
    "/etc/systemd/system/gh-runner-gate.service",
    "/etc/systemd/system/gh-runner-3.service",
    "/etc/systemd/system/gh-runners.slice",
    "/etc/systemd/system/ghgate.slice",
    "/etc/systemd/system/gh-runner-nft.service",
    "/etc/sudoers.d/91-gh-runner-control",
    "/etc/gh-runner/nft.rules",
    "/srv/gh-runner/hooks/job-started.sh",
    "/srv/gh-runner/hooks/clean-old.sh",
    "/srv/gh-runner/bin/runner-pause.sh",
    "/srv/gh-runner/bin/runner-resume.sh",
    "/srv/gh-runner/bin/notes.txt",
    "/srv/gh-runner/bin",
    "/srv/gh-runner/runner/config.sh",
    "/srv/gh-runner/home",
    "/srv/gh-runner-2",
    "/srv/gh-runner-gate",
    "/srv/gh-runner-3",
    "/srv/gh-runner-share",
    "/srv/gh-runner-share/43003101968-1",
  ];

  const installWithFailingRuleCheck = (nftCheck, extraSetup = [], stderrRedirect) => {
    const box = sandbox();
    box.fake("hostname", "echo ci-vps");
    box.fake(
      "id",
      [
        `case "\${@: -1}" in`,
        '  gh-runner) [ "$1" = -u ] && echo 996; [ "$1" = -nG ] && echo gh-runner; exit 0 ;;',
        `  gh-runner-2) [ -e "${box.root}/user-gh-runner-2" ] || exit 1; [ "$1" = -u ] && echo 995; [ "$1" = -nG ] && echo gh-runner-2; exit 0 ;;`,
        `  gh-runner-gate) [ -e "${box.root}/user-gh-runner-gate" ] || exit 1; [ "$1" = -u ] && echo 994; [ "$1" = -nG ] && echo gh-runner-gate; exit 0 ;;`,
        `  gh-runner-3) [ -e "${box.root}/user-gh-runner-3" ] || exit 1; [ "$1" = -u ] && echo 993; [ "$1" = -nG ] && echo gh-runner-3; exit 0 ;;`,
        "esac",
        "echo 0",
      ].join("\n"),
    );
    box.fake("useradd", `${box.record("useradd")}\ntouch "${box.root}/user-\${@: -1}"`);
    box.fake("userdel", `${box.record("userdel")}\nrm -f "${box.root}/user-$1"`);
    box.fake("pkill", `${box.record("pkill")}\nexit 1`);
    box.fake("getent", '[ -e "/etc/fake-group-$2" ] && exit 0\nexit 2');
    box.fake("groupadd", box.record("groupadd"));
    box.fake("groupdel", box.record("groupdel"));
    box.fake(
      "install",
      `args=()\nwhile [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done\nexec /usr/bin/install "\${args[@]}"`,
    );
    box.fake("curl", 'while [ $# -gt 0 ]; do [ "$1" = -o ] && : > "$2"; shift; done');
    box.fake("ss", "printf '%s\\n' 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*'");
    box.fake("nft", `${box.record("nft")}\nif [ "$1" = -c ]; then ${nftCheck}; fi\nexit 0`);
    box.fake(
      "systemctl",
      `${box.record("systemctl")}\ncase "$1" in is-active) exit 3 ;; is-enabled) exit 1 ;; esac\nexit 0`,
    );
    for (const name of ["visudo", "python3", "sudo"]) box.fake(name, "exit 0");
    box.fake("sha256sum", "cat > /dev/null\nexit 0");
    const inner = [
      "set -u",
      `real="${box.root}/real"`,
      'for dir in etc var; do mkdir -p "$real/$dir" && mount --rbind "/$dir" "$real/$dir" || exit 90; done',
      `mkdir -p "$real/scripts" && mount --bind "${scripts}" "$real/scripts" || exit 92`,
      "for dir in /etc /var /srv; do mount -t tmpfs tmpfs $dir || exit 91; done",
      "keep() {",
      '  for entry in "$real/$1"/*; do',
      `    case " $2 " in *" \${entry##*/} "*) ;; *) ln -s "$entry" "/$1/\${entry##*/}" ;; esac`,
      "  done",
      "}",
      'keep etc "systemd sudoers.d gh-runner"',
      'keep var "backups"',
      "mkdir -p /etc/systemd/system /etc/sudoers.d /etc/gh-runner /srv/gh-runner/runner /srv/gh-runner/hooks /srv/gh-runner/bin",
      "echo old-unit > /etc/systemd/system/gh-runner.service",
      "echo old-sudoers > /etc/sudoers.d/91-gh-runner-control",
      "echo old-rules > /etc/gh-runner/nft.rules",
      "echo old-hook > /srv/gh-runner/hooks/job-started.sh",
      "echo old-pause > /srv/gh-runner/bin/runner-pause.sh",
      "echo config > /srv/gh-runner/runner/config.sh",
      "chmod 0755 /srv/gh-runner/runner/config.sh",
      ...extraSetup,
      `bash "$real/scripts/install-runner.sh" > "${box.root}/stdout" ${stderrRedirect ?? `2> "${box.root}/stderr"`}`,
      'echo "rc=$?"',
      `for path in ${reported.join(" ")}; do`,
      '  if [ -d "$path" ]; then echo "$path=DIR"; elif [ -e "$path" ]; then echo "$path=$(cat "$path")"; else echo "$path=MISSING"; fi',
      "done",
    ].join("\n");
    const result = spawnSync("bwrap", asRootInPrivateMounts(inner), {
      encoding: "utf8",
      env: { PATH: `${box.root}/bin:${process.env.PATH}`, HOME: box.root },
    });
    const state = Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const stderrFile = path.join(box.root, "stderr");
    const stderr = existsSync(stderrFile)
      ? readFileSync(stderrFile, "utf8")
      : `namespace setup failed: ${result.status} ${result.stdout} ${result.stderr}`;
    return { box, result, state, stderr };
  };

  it("puts every file back even when stderr cannot be written", () => {
    const { box, result, state } = installWithFailingRuleCheck("exit 1", [], "2>&-");
    expect(result.status).toBe(0);
    expect(state.rc).toBe("1");
    expect(state["/etc/systemd/system/gh-runner.service"]).toBe("old-unit");
    expect(state["/etc/sudoers.d/91-gh-runner-control"]).toBe("old-sudoers");
    expect(state["/srv/gh-runner-2"]).toBe("MISSING");
    expect(box.calls()).toMatch(/^userdel gh-runner-2$/m);
  });

  it("puts every file back when stderr is a pipe nobody reads any more", () => {
    const { box, result, state } = installWithFailingRuleCheck(
      "exit 1",
      [`mkfifo "$HOME/gone"`, `(exec 5< "$HOME/gone") & exec 3> "$HOME/gone"; wait`],
      "2>&3",
    );
    expect(result.status).toBe(0);
    expect(state.rc).not.toBe("0");
    expect(state["/etc/systemd/system/gh-runner.service"]).toBe("old-unit");
    expect(state["/etc/sudoers.d/91-gh-runner-control"]).toBe("old-sudoers");
    expect(state["/etc/gh-runner/nft.rules"]).toBe("old-rules");
    expect(state["/srv/gh-runner-2"]).toBe("MISSING");
    expect(box.calls()).toMatch(/^userdel gh-runner-2$/m);
  });

  it("refuses to take over a share directory whose group it would have to create, and leaves it alone", () => {
    const { box, state, stderr } = installWithFailingRuleCheck("exit 0", [
      "mkdir -p /srv/gh-runner-share",
    ]);
    expect(state.rc).toBe("71");
    expect(stderr).toContain("refusing to take over");
    expect(state["/srv/gh-runner-share"]).toBe("DIR");
    expect(box.calls()).not.toMatch(/^group(add|del) /m);
  });

  it("reinstalls over a share directory whose group already exists, and keeps the group and directory", () => {
    const { box, result, state } = installWithFailingRuleCheck("exit 0", [
      "mkdir -p /srv/gh-runner-share/43003101968-1",
      "touch /etc/fake-group-gh-ci-share",
    ]);
    expect(result.status).toBe(0);
    expect(state.rc).toBe("0");
    expect(state["/srv/gh-runner-share"]).toBe("DIR");
    expect(state["/srv/gh-runner-share/43003101968-1"]).toBe("DIR");
    expect(box.calls()).not.toMatch(/^group(add|del) /m);
  });

  it("keeps /srv/gh-runner/bin and files it did not install when the install succeeds", () => {
    const { result, state } = installWithFailingRuleCheck("exit 0", [
      "echo mine > /srv/gh-runner/bin/notes.txt",
    ]);
    expect(result.status).toBe(0);
    expect(state.rc).toBe("0");
    expect(state["/srv/gh-runner/bin/runner-pause.sh"]).toBe("MISSING");
    expect(state["/srv/gh-runner/bin/notes.txt"]).toBe("mine");
  });

  it("removes the old pause scripts in /srv/gh-runner/bin when the install succeeds", () => {
    const { box, result, state, stderr } = installWithFailingRuleCheck("exit 0");
    expect(result.status).toBe(0);
    expect(stderr).not.toContain("INSTALL_FAILED");
    expect(state.rc).toBe("0");
    expect(state["/srv/gh-runner/bin/runner-pause.sh"]).toBe("MISSING");
    expect(state["/srv/gh-runner/bin/runner-resume.sh"]).toBe("MISSING");
    expect(state["/srv/gh-runner/hooks/job-started.sh"]).not.toBe("old-hook");
    expect(state["/srv/gh-runner/bin"]).toBe("MISSING");
    expect(state["/srv/gh-runner-gate"]).toBe("DIR");
    expect(state["/etc/systemd/system/gh-runner-gate.service"]).toBe("[Unit]");
    expect(state["/srv/gh-runner-3"]).toBe("DIR");
    expect(state["/etc/systemd/system/gh-runner-3.service"]).toBe("[Unit]");
    expect(state["/etc/systemd/system/ghgate.slice"]).toBe("[Unit]");
    expect(state["/srv/gh-runner-share"]).toBe("DIR");
    expect(box.calls()).toMatch(/^groupadd --system gh-ci-share$/m);
  });

  it.each([
    ["a failed step", "exit 1", "1"],
    ["a TERM signal", "kill -TERM $PPID; exit 0", "130"],
  ])("puts every file back and deletes the new account after %s", (_, nftCheck, code) => {
    const { box, result, state, stderr } = installWithFailingRuleCheck(nftCheck);
    expect(result.status).toBe(0);
    expect(state.rc).toBe(code);
    expect(stderr).toContain("INSTALL_FAILED");
    if (code === "1") expect(stderr).toMatch(/INSTALL_STEP_FAILED line \d+ exit 1: return 1/);
    expect(stderr).not.toContain("RESTORE_INCOMPLETE");
    expect(stderr).not.toContain("command not found");
    expect(stderr).not.toContain("unbound variable");
    expect(readFileSync(path.join(box.root, "stdout"), "utf8")).toBe("");
    expect(box.calls()).toMatch(/^nft -c -f /m);
    expect(box.calls()).not.toMatch(/^systemctl (enable|is-enabled) /m);
    expect(box.calls()).toMatch(/^useradd .*gh-runner-2$/m);
    expect(box.calls()).toMatch(/^userdel gh-runner-2$/m);
    expect(box.calls()).toMatch(/^useradd .*gh-runner-gate$/m);
    expect(box.calls()).toMatch(/^userdel gh-runner-gate$/m);
    expect(box.calls()).toMatch(/^useradd .*gh-runner-3$/m);
    expect(box.calls()).toMatch(/^userdel gh-runner-3$/m);
    expect(box.calls()).toMatch(/^nft -f \/etc\/gh-runner\/nft.rules$/m);
    expect(box.calls()).toMatch(/^groupadd --system gh-ci-share$/m);
    expect(state).toEqual({
      rc: code,
      "/etc/systemd/system/gh-runner.service": "old-unit",
      "/etc/systemd/system/gh-runner-2.service": "MISSING",
      "/etc/systemd/system/gh-runner-gate.service": "MISSING",
      "/etc/systemd/system/gh-runner-3.service": "MISSING",
      "/etc/systemd/system/gh-runners.slice": "MISSING",
      "/etc/systemd/system/ghgate.slice": "MISSING",
      "/etc/systemd/system/gh-runner-nft.service": "MISSING",
      "/etc/sudoers.d/91-gh-runner-control": "old-sudoers",
      "/etc/gh-runner/nft.rules": "old-rules",
      "/srv/gh-runner/hooks/job-started.sh": "old-hook",
      "/srv/gh-runner/hooks/clean-old.sh": "MISSING",
      "/srv/gh-runner/bin/runner-pause.sh": "old-pause",
      "/srv/gh-runner/bin/runner-resume.sh": "MISSING",
      "/srv/gh-runner/bin/notes.txt": "MISSING",
      "/srv/gh-runner/bin": "DIR",
      "/srv/gh-runner/runner/config.sh": "config",
      "/srv/gh-runner/home": "MISSING",
      "/srv/gh-runner-2": "MISSING",
      "/srv/gh-runner-gate": "MISSING",
      "/srv/gh-runner-3": "MISSING",
      "/srv/gh-runner-share": "MISSING",
      "/srv/gh-runner-share/43003101968-1": "MISSING",
    });
  });
});

describe("scripts started by bare file name from their own directory", () => {
  it.each(["register-runner.sh", "uninstall-runner.sh"])("%s still finds runners.sh", (script) => {
    const box = sandbox();
    box.fake("hostname", "echo ci-vps");
    box.fake("id", "echo 0");
    box.fake("python3", "exit 0");
    box.fake("nft", "exit 0");
    const result = spawnSync("/bin/bash", [script], {
      cwd: scripts,
      encoding: "utf8",
      input: "",
      env: { PATH: `${box.root}/bin:${process.env.PATH}`, HOME: box.root },
    });
    expect(result.stderr).not.toContain("runners.sh");
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("usage");
  });
});

describe("uninstall-runner.sh", () => {
  const uninstallBox = () => {
    const box = sandbox();
    box.fake("hostname", "echo ci-vps");
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
    expect(box.calls()).toContain("rm -rf /etc/gh-runner /srv/gh-runner-share\n");
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
    const inner = [
      `scripts="${box.root}/scripts"`,
      `mkdir -p "$scripts" && mount --bind "${scripts}" "$scripts" || exit 92`,
      "for dir in /srv /etc/systemd/system /etc/gh-runner; do [ -d $dir ] || continue; mount -t tmpfs tmpfs $dir || exit 91; done",
      'exec bash "$scripts/uninstall-runner.sh" 2',
    ].join("\n");
    const result = spawnSync("bwrap", asRootInPrivateMounts(inner), {
      encoding: "utf8",
      env: { PATH: `${box.root}/bin:${process.env.PATH}`, HOME: box.root },
    });
    expect(result.stderr, result.stderr).not.toContain("UNINSTALL_INCOMPLETE");
    expect(result.status).toBe(0);
    const calls = box.calls();
    expect(calls).toContain("systemctl disable --now gh-runner-2.service\n");
    expect(calls).toContain("userdel gh-runner-2\n");
    expect(calls).toContain("rm -rf /srv/gh-runner-2\n");
    expect(calls).not.toContain("gh-runner.service");
    expect(calls).not.toMatch(/userdel gh-runner\n|pkill -u gh-runner\n|\/srv\/gh-runner(\s|\/|$)/);
    expect(calls).not.toContain("nft delete table");
    expect(calls).not.toContain("gh-runner-share");
    expect(calls).not.toContain("groupdel gh-ci-share");
    expect(readFileSync(path.join(box.root, "nft-checked"), "utf8")).toContain(
      "meta skuid { 996 }",
    );
    expect(readFileSync(path.join(box.root, "sudoers-checked"), "utf8")).toBe(
      "ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl start gh-runner.service, /usr/bin/systemctl stop gh-runner.service, /usr/bin/systemctl restart gh-runner.service\n",
    );
  });
});

const threeRunners = (overrides = {}) =>
  macBox({
    runners: [
      [11, "ci-vps-1"],
      [12, "ci-vps-2"],
      [13, "ci-vps-gate"],
    ],
    vpsNames: ["ci-vps-1", "ci-vps-2", "ci-vps-gate"],
    ...overrides,
  });

describe("[HR-11] the gate runner keeps its own label", () => {
  const read = (relative) =>
    readFileSync(path.resolve(import.meta.dirname, "../..", relative), "utf8");

  it("runners.sh gives the two check runners the workflow label and the gate runner only ci-vps-gate", () => {
    const result = shell(
      'for id in $RUNNER_IDS; do runner_select $id; echo "$RUNNER_NAME=$RUNNER_LABEL"; done; echo "$RUNNER_LABELS"',
    );
    expect(result.stdout).toBe(
      `ci-vps-1=${linuxRunnerLabel}\nci-vps-2=${linuxRunnerLabel}\nci-vps-gate=ci-vps-gate\nci-vps-3=${linuxRunnerLabel}\n${linuxRunnerLabel} ci-vps-gate\n`,
    );
    expect(shell("runner_label_for_name ci-vps-gate").stdout).toBe("ci-vps-gate\n");
    expect(shell("runner_label_for_name ci-vps-9").status).not.toBe(0);
  });

  it("only the required job runs on the gate label, the policy, static and security jobs on the ARM label, and ci/policy.json, ci.yml, actionlint, the schema and runners.sh agree on the labels", () => {
    const gateLabel = shell('printf "%s" "$RUNNER_GATE_LABEL"').stdout;
    expect(gateLabel).toBe(gateRunnerLabel);
    expect(shell('printf "%s" "$RUNNER_CHECK_LABEL"').stdout).toBe(linuxRunnerLabel);
    expect(shell('printf "%s" "$RUNNER_ARM_LABEL"').stdout).toBe(armRunnerLabel);
    const labelFor = (id) =>
      id === "required"
        ? gateRunnerLabel
        : armChecks.includes(id)
          ? armRunnerLabel
          : linuxRunnerLabel;
    const policy = JSON.parse(read("ci/policy.json"));
    for (const check of policy.checks)
      for (const member of check.members) {
        if (member.os !== "linux") continue;
        expect([check.id, member.runner]).toEqual([check.id, labelFor(check.id)]);
      }
    const actionlint = read(".github/actionlint.yaml");
    expect(actionlint).toContain(`- ${linuxRunnerLabel}\n`);
    expect(actionlint).toContain(`- ${gateRunnerLabel}\n`);
    expect(actionlint).toContain(`- ${armRunnerLabel}\n`);
    const schema = read("ci/policy.schema.json");
    expect(schema).toContain(`"${linuxRunnerLabel}"`);
    expect(schema).toContain(`"${gateRunnerLabel}"`);
    expect(schema).toContain(`"${armRunnerLabel}"`);
    const workflow = parse(read(".github/workflows/ci.yml"));
    const fixed = Object.entries(workflow.jobs)
      .filter(([, job]) => !String(job["runs-on"]).startsWith("$"))
      .map(([id, job]) => [id, job["runs-on"]]);
    expect(fixed.length).toBeGreaterThan(1);
    for (const [id, label] of fixed) expect([id, label]).toEqual([id, labelFor(id)]);
    expect(Object.fromEntries(fixed).required).toBe(gateRunnerLabel);
    for (const id of armChecks) expect(workflow.jobs[id]["runs-on"]).toBe(armRunnerLabel);
    expect(existsSync(".github/workflows/ci-arm-trial.yml")).toBe(false);
    const matrixRunners = Object.values(workflow.jobs).flatMap((job) =>
      (job.strategy?.matrix?.include ?? []).map((entry) => entry.runner),
    );
    expect(matrixRunners.length).toBeGreaterThan(0);
    expect(matrixRunners).not.toContain(gateRunnerLabel);
  });

  it("register-runner.sh registers each runner with the label runners.sh selected for it", () => {
    const text = read("scripts/operations/ci-runner/register-runner.sh");
    expect(text).toContain('1|2|3|6) runner_select "$1" ;;');
    expect(text).toContain('--labels "$RUNNER_LABEL"');
  });
});

describe("pause and resume with the gate runner", () => {
  it("pause removes ci-vps from the check runners and ci-vps-gate from the gate runner", () => {
    const box = threeRunners();
    const result = box.mac("pause-runners.sh");
    expect(result.stdout).toContain("RUNNER_PAUSED");
    expect(result.status).toBe(0);
    expect(box.managedLabels()).toEqual({ "ci-vps-1": [], "ci-vps-2": [], "ci-vps-gate": [] });
    const removals = box.lines().filter((line) => line.includes("-X DELETE"));
    expect(removals).toEqual([
      "gh api -X DELETE repos/sixianli/himawari-agent/actions/runners/11/labels/ci-vps",
      "gh api -X DELETE repos/sixianli/himawari-agent/actions/runners/12/labels/ci-vps",
      "gh api -X DELETE repos/sixianli/himawari-agent/actions/runners/13/labels/ci-vps-gate",
    ]);
  });

  it("pause also removes the fallback gate label from the first check runner", () => {
    const box = threeRunners({
      runners: [
        [11, "ci-vps-1", ["ci-vps", "ci-vps-gate"]],
        [12, "ci-vps-2"],
        [13, "ci-vps-gate"],
      ],
    });
    expect(box.mac("pause-runners.sh").status).toBe(0);
    expect(box.managedLabels()["ci-vps-1"]).toEqual([]);
  });

  it("pause refuses to stop services while the gate label could not be removed, and puts every label back", () => {
    const box = threeRunners();
    box.set("ignore-delete-13", "");
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("RUNNER_PAUSE_FAILED a runner label is still on: ci-vps-gate");
    expect(box.managedLabels()).toEqual({
      "ci-vps-1": ["ci-vps"],
      "ci-vps-2": ["ci-vps"],
      "ci-vps-gate": ["ci-vps-gate"],
    });
    expect(box.lines().some((line) => line.includes("--labels-removed"))).toBe(false);
  });

  it("resume gives every runner back its own label and never puts ci-vps on the gate runner", () => {
    const box = threeRunners({ labelled: false });
    box.set("online-from", 1);
    const result = box.mac("resume-runners.sh");
    expect(result.stdout).toContain("RUNNER_RESUMED");
    expect(result.status).toBe(0);
    expect(box.managedLabels()).toEqual({
      "ci-vps-1": ["ci-vps"],
      "ci-vps-2": ["ci-vps"],
      "ci-vps-gate": ["ci-vps-gate"],
    });
  });

  it("resume does not start services while the gate runner carries only the check label", () => {
    const box = threeRunners({
      runners: [
        [11, "ci-vps-1"],
        [12, "ci-vps-2"],
        [13, "ci-vps-gate", ["ci-vps"]],
      ],
    });
    box.set("fail-add-13", "");
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ci-vps-gate=foreign");
    expect(box.lines().some((line) => /^ssh .*runner-resume\.sh/.test(line))).toBe(false);
  });

  it.each([
    [
      "the gate runner also carries the check label",
      [
        [11, "ci-vps-1"],
        [12, "ci-vps-2"],
        [13, "ci-vps-gate", ["ci-vps-gate", "ci-vps"]],
      ],
      "ci-vps-gate=mixed",
    ],
    [
      "the second check runner also carries the gate label",
      [
        [11, "ci-vps-1"],
        [12, "ci-vps-2", ["ci-vps", "ci-vps-gate"]],
        [13, "ci-vps-gate"],
      ],
      "ci-vps-2=mixed",
    ],
  ])("resume does not start services while %s", (_, runners, state) => {
    const box = threeRunners({ runners });
    box.set("online-from", 1);
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(state);
    expect(result.stdout).toContain("RUNNER_RESUME_INCOMPLETE");
    expect(box.lines().some((line) => /^ssh .*runner-resume\.sh/.test(line))).toBe(false);
  });

  it("resume starts services while the first check runner carries the fallback gate label", () => {
    const box = threeRunners({
      runners: [
        [11, "ci-vps-1", ["ci-vps", "ci-vps-gate"]],
        [12, "ci-vps-2"],
        [13, "ci-vps-gate"],
      ],
    });
    box.set("online-from", 1);
    const result = box.mac("resume-runners.sh");
    expect(result.stdout).toContain("RUNNER_RESUMED");
    expect(result.status).toBe(0);
  });

  it("pause and resume refuse to act when GitHub has a ci-vps-gate runner that is not on the VPS", () => {
    const box = threeRunners({ vpsNames: ["ci-vps-1", "ci-vps-2"] });
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ci-vps-gate carries ci-vps-gate but is not installed");
    expect(box.lines().some((line) => line.includes("-X DELETE"))).toBe(false);
  });
});

describe("gate-fallback.sh", () => {
  const fallback = (box, ...args) =>
    spawnSync("/bin/bash", [path.join(scripts, "gate-fallback.sh"), ...args], {
      encoding: "utf8",
      env: {
        PATH: `${box.root}/bin:${process.env.PATH}`,
        HOME: box.root,
        RUNNER_LOCK_DIR: path.join(box.root, "lock"),
      },
    });

  it("asks for on or off and touches nothing otherwise", () => {
    const box = threeRunners();
    const result = fallback(box);
    expect(result.status).toBe(64);
    expect(result.stdout).toContain("usage");
    expect(box.calls()).toBe("");
  });

  it("on adds ci-vps-gate to the first check runner only, off takes it away again", () => {
    const box = threeRunners();
    box.set("online-from", 1);
    const on = fallback(box, "on");
    expect(on.stdout).toContain("GATE_FALLBACK_ON ci-vps-1");
    expect(on.status).toBe(0);
    expect(box.managedLabels()).toEqual({
      "ci-vps-1": ["ci-vps", "ci-vps-gate"],
      "ci-vps-2": ["ci-vps"],
      "ci-vps-gate": ["ci-vps-gate"],
    });
    const off = fallback(box, "off");
    expect(off.stdout).toContain("GATE_FALLBACK_OFF ci-vps-1");
    expect(off.status).toBe(0);
    expect(box.managedLabels()["ci-vps-1"]).toEqual(["ci-vps"]);
    expect(existsSync(path.join(box.root, "lock"))).toBe(false);
  });

  it("on is refused while the first check runner is offline, because it could not take the jobs either", () => {
    const box = threeRunners();
    box.set("online-from", 99);
    const result = fallback(box, "on");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("GATE_FALLBACK_FAILED ci-vps-1 is offline");
    expect(box.managedLabels()["ci-vps-1"]).toEqual(["ci-vps"]);
  });

  it("on warns when the gate runner is still online, and says nothing extra when it is offline", () => {
    const online = threeRunners();
    online.set("online-from", 1);
    expect(fallback(online, "on").stdout).toContain("note: ci-vps-gate is online");
    const offline = threeRunners();
    writeFileSync(
      path.join(offline.root, "bin", "gh"),
      readFileSync(path.join(offline.root, "bin", "gh"), "utf8").replace(
        '(n >= o) ? "online" : "offline"',
        '($2 == "ci-vps-gate") ? "offline" : "online"',
      ),
    );
    const result = fallback(offline, "on");
    expect(result.stdout).toContain("GATE_FALLBACK_ON ci-vps-1");
    expect(result.stdout).not.toContain("note:");
  });

  it("on is refused while the runners are paused", () => {
    const box = threeRunners({ labelled: false });
    const result = fallback(box, "on");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("run resume-runners.sh first");
    expect(box.managedLabels()["ci-vps-1"]).toEqual([]);
  });

  it("on reports failure when GitHub did not take the label", () => {
    const box = threeRunners();
    box.set("online-from", 1);
    box.set("fail-add-11", "");
    const result = fallback(box, "on");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("GATE_FALLBACK_FAILED ci-vps-gate is not on ci-vps-1");
  });

  it("off reports failure when the label is still there", () => {
    const box = threeRunners({
      runners: [
        [11, "ci-vps-1", ["ci-vps", "ci-vps-gate"]],
        [12, "ci-vps-2"],
        [13, "ci-vps-gate"],
      ],
    });
    box.set("ignore-delete-11", "");
    const result = fallback(box, "off");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("GATE_FALLBACK_FAILED ci-vps-gate is still on ci-vps-1");
  });

  it("changes nothing when GitHub cannot be read", () => {
    const box = threeRunners();
    box.set("fail-list-from", 1);
    const result = fallback(box, "on");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("labels untouched");
    expect(box.lines().some((line) => line.includes("/labels"))).toBe(false);
  });
});

describe("uninstall-runner.sh with the gate runner", () => {
  const box3 = () => {
    const box = sandbox();
    box.fake("hostname", "echo ci-vps");
    for (const name of ["systemctl", "rm", "pkill", "groupdel"])
      box.fake(name, `${box.record(name)}\nexit 0`);
    box.fake("getent", "exit 2");
    box.fake("nft", '[ "$1" = list ] && exit 1\nexit 0');
    box.fake("userdel", `${box.record("userdel")}\ntouch "${box.root}/gone-$1"\nexit 0`);
    return box;
  };

  it("all removes the gate runner, its unit, its directory and its slice", () => {
    const box = box3();
    box.fake(
      "id",
      `[ -e "${box.root}/gone-\${@: -1}" ] && exit 1\n[ "$1" = -u ] && echo 0\nexit 0`,
    );
    const inner = [
      `scripts="${box.root}/scripts"`,
      `mkdir -p "$scripts" && mount --bind "${scripts}" "$scripts" || exit 92`,
      "mount -t tmpfs tmpfs /srv && mount -t tmpfs tmpfs /etc || exit 91",
      "mkdir -p /etc/systemd/system /etc/sudoers.d || exit 91",
      'exec bash "$scripts/uninstall-runner.sh" all',
    ].join("\n");
    const result = spawnSync("bwrap", asRootInPrivateMounts(inner), {
      encoding: "utf8",
      env: { PATH: `${box.root}/bin:${process.env.PATH}`, HOME: box.root },
    });
    const calls = box.calls();
    expect(result.stderr, result.stderr).not.toContain("UNINSTALL_INCOMPLETE");
    for (const [user, unit, root] of [
      ["gh-runner", "gh-runner.service", "/srv/gh-runner"],
      ["gh-runner-2", "gh-runner-2.service", "/srv/gh-runner-2"],
      ["gh-runner-gate", "gh-runner-gate.service", "/srv/gh-runner-gate"],
      ["gh-runner-3", "gh-runner-3.service", "/srv/gh-runner-3"],
    ]) {
      expect(calls).toContain(`systemctl disable --now ${unit}\n`);
      expect(calls).toContain(`rm -f /etc/systemd/system/${unit}\n`);
      expect(calls).toContain(`rm -rf ${root}\n`);
      expect(calls).toContain(`userdel ${user}\n`);
    }
    expect(calls).toContain(
      "rm -f /etc/systemd/system/gh-runners.slice /etc/systemd/system/ghgate.slice /etc/systemd/system/gh-runner-nft.service /etc/systemd/system/gh-runner-clean.service /etc/systemd/system/gh-runner-clean.timer\n",
    );
    expect(calls).toContain("rm -f /etc/sudoers.d/91-gh-runner-control\n");
    expect(calls).toContain("rm -rf /etc/gh-runner /srv/gh-runner-share\n");
    expect(result.stdout).toContain(
      "UNINSTALL_OK removed: ci-vps-1 ci-vps-2 ci-vps-gate ci-vps-3;",
    );
    expect(result.status).toBe(0);
  });

  it("the usage text offers removing only the gate runner or only the third check runner", () => {
    const box = box3();
    box.fake("id", "echo 0");
    const result = box.run("uninstall-runner.sh", ["1"]);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("<2|3|6|all>");
  });
});

const armShell = (body) =>
  spawnSync("/bin/bash", ["-c", `source "${scripts}/runners.sh"\n${body}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, RUNNER_SITE: "arm" },
  });

const fiveRunners = (overrides = {}) =>
  macBox({
    runners: [
      [11, "ci-vps-1"],
      [12, "ci-vps-2"],
      [13, "ci-vps-gate"],
      [14, "ci-arm-1"],
      [15, "ci-arm-2"],
      [16, "ci-vps-3"],
    ],
    vpsNames: ["ci-vps-1", "ci-vps-2", "ci-vps-gate", "ci-vps-3"],
    ...overrides,
  });

describe("[ADR-0266] the ARM machine is a second site with its own runners", () => {
  it("RUNNER_SITE=arm selects runners 4 and 5 with the ci-arm label, the arm64 package and their own slice", () => {
    const result = armShell(
      'for id in $RUNNER_IDS; do runner_select $id; echo "$RUNNER_NAME $RUNNER_USER $RUNNER_ROOT $RUNNER_UNIT $RUNNER_LABEL $RUNNER_SLICE $RUNNER_OTHER_ROOTS"; done; echo "$RUNNER_LABELS|$RUNNER_SLICE_UNITS|$RUNNER_PACKAGE_ARCH|$RUNNER_GATE_LABEL|"',
    );
    expect(result.stdout).toBe(
      [
        "ci-arm-1 gh-runner-arm-1 /srv/gh-runner-arm-1 gh-runner-arm-1.service ci-arm gh-arm-runners.slice /srv/gh-runner-arm-2",
        "ci-arm-2 gh-runner-arm-2 /srv/gh-runner-arm-2 gh-runner-arm-2.service ci-arm gh-arm-runners.slice /srv/gh-runner-arm-1",
        "ci-arm|gh-arm-runners.slice|arm64||",
        "",
      ].join("\n"),
    );
    expect(armShell('printf "%s" "$RUNNER_PACKAGE_SHA256"').stdout).toBe(
      "670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945",
    );
    expect(shell('printf "%s %s" "$RUNNER_PACKAGE_ARCH" "$RUNNER_PACKAGE_SHA256"').stdout).toBe(
      "x64 baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40",
    );
  });

  it("a site refuses the other site's runner numbers, and an unknown site is refused", () => {
    const wrong = armShell("runner_select 1; echo rc=$?");
    expect(wrong.stdout).toBe("rc=64\n");
    expect(wrong.stderr).toContain("runner 1 does not belong to site arm");
    expect(shell("runner_select 4; echo rc=$?").stdout).toBe("rc=64\n");
    const unknown = spawnSync("/bin/bash", ["-c", `source "${scripts}/runners.sh"; echo sourced`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, RUNNER_SITE: "mars" },
    });
    expect(unknown.stdout).not.toContain("sourced");
    expect(unknown.stderr).toContain("unknown RUNNER_SITE: mars");
  });

  it("the two ARM runners together may use at most 18 GiB, leaving 6 GiB of the 24 GiB machine for tests", () => {
    const slice = unitSettings(readFileSync(path.join(scripts, "gh-arm-runners.slice"), "utf8"));
    expect(bytes(slice.MemoryMax)).toBe(18 * 1024 ** 3);
    expect(bytes(slice.MemoryHigh)).toBeLessThan(bytes(slice.MemoryMax));
    expect(slice.MemorySwapMax).toBe("0");
    const unit = unitSettings(
      armShell(`render_runner_unit 4 "${scripts}/gh-runner.service.in"`).stdout,
    );
    expect(unit.Slice).toBe("gh-arm-runners.slice");
    expect(unit.User).toBe("gh-runner-arm-1");
    expect(unit.ProtectHome).toBe("yes");
    expect(unit.InaccessiblePaths).toContain("-/srv/gh-runner-arm-2");
    expect(bytes(unit.MemoryMax)).toBeLessThanOrEqual(bytes(slice.MemoryMax));
  });

  it("root scripts with RUNNER_SITE=arm refuse a machine that is not Linux on aarch64", () => {
    for (const [script, args] of [
      ["install-runner.sh", []],
      ["register-runner.sh", ["4"]],
      ["uninstall-runner.sh", ["all"]],
    ]) {
      const box = sandbox();
      box.fake("uname", '[ "$1" = -s ] && echo Linux || echo x86_64');
      box.fake("id", "echo 0");
      const result = box.run(script, args, { env: { RUNNER_SITE: "arm" }, input: "token\n" });
      expect([script, result.status]).toEqual([script, 68]);
      expect(result.stderr).toContain("only runs on the Linux ARM machine");
    }
  });

  it("register-runner.sh takes 4 and 5 only with RUNNER_SITE=arm, and 1 to 3 only without", () => {
    const box = sandbox();
    box.fake("uname", '[ "$1" = -s ] && echo Linux || echo aarch64');
    box.fake("hostname", "echo ci-vps");
    box.fake("id", "echo 0");
    const arm = { env: { RUNNER_SITE: "arm" } };
    expect(box.run("register-runner.sh", ["4"], arm).stderr).toContain("no registration token");
    expect(box.run("register-runner.sh", ["5"], arm).stderr).toContain("no registration token");
    expect(box.run("register-runner.sh", ["3"], { ...arm, input: "t\n" }).stderr).toContain(
      "usage",
    );
    expect(box.run("register-runner.sh", ["5"], { input: "t\n" }).stderr).toContain("usage");
  });

  it("install-runner.sh on the ARM machine refuses to start without the report key and the CI VPS address", () => {
    const box = sandbox();
    box.fake("uname", '[ "$1" = -s ] && echo Linux || echo aarch64');
    box.fake("id", "echo 0");
    for (const tool of [
      "nft",
      "visudo",
      "useradd",
      "groupadd",
      "getent",
      "sha256sum",
      "curl",
      "ss",
      "python3",
      "sshd",
      "systemctl",
    ])
      box.fake(tool, `${box.record(tool)}\nexit 0`);
    const key = `ssh-ed25519 ${"A".repeat(68)}`;
    const attempt = (env) =>
      box.run("install-runner.sh", [], { env: { RUNNER_SITE: "arm", ...env } });
    for (const env of [
      {},
      { RUNNER_SEND_PUBLIC_KEY: key },
      { RUNNER_SEND_PUBLIC_KEY: `${key} comment`, RUNNER_SEND_FROM: "192.0.2.1" },
      { RUNNER_SEND_PUBLIC_KEY: `${key}",command="/bin/sh`, RUNNER_SEND_FROM: "192.0.2.1" },
      { RUNNER_SEND_PUBLIC_KEY: key, RUNNER_SEND_FROM: '192.0.2.1",from="*' },
      { RUNNER_SEND_PUBLIC_KEY: key, RUNNER_SEND_FROM: "ci-vps.example" },
    ]) {
      const result = attempt(env);
      expect([env, result.status]).toEqual([env, 64]);
      expect(result.stderr).toMatch(/RUNNER_SEND_(PUBLIC_KEY|FROM) must be/);
    }
    expect(box.calls()).not.toMatch(/^(useradd|groupadd|nft|systemctl) /m);
  });
});

describe("[ADR-0266] install-runner.sh on the ARM machine, run as root in a private mount namespace", () => {
  const key = `ssh-ed25519 ${"B".repeat(68)}`;
  const reported = [
    "/etc/systemd/system/gh-runner-arm-1.service",
    "/etc/systemd/system/gh-runner-arm-2.service",
    "/etc/systemd/system/gh-arm-runners.slice",
    "/etc/systemd/system/gh-runners.slice",
    "/etc/systemd/system/ghgate.slice",
    "/etc/systemd/system/gh-runner-clean.service",
    "/etc/sudoers.d/91-gh-runner-control",
    "/etc/gh-runner/nft.rules",
    "/srv/gh-runner/hooks/clean-old.sh",
    "/srv/gh-runner/hooks/runners.sh",
    "/srv/gh-runner-arm-1/hooks/job-started.sh",
    "/srv/gh-runner-arm-2/runner",
    "/srv/gh-runner-share",
    "/usr/local/lib/gh-runner/send-reports",
    "/var/lib/gh-ci-send/.ssh/authorized_keys",
    "/var/lib/gh-ci-send",
  ];
  const install = (nftCheck) => {
    const box = sandbox();
    box.fake("uname", '[ "$1" = -s ] && echo Linux || echo aarch64');
    box.fake(
      "id",
      [
        `case "\${@: -1}" in`,
        `  gh-runner-arm-1|gh-runner-arm-2|gh-ci-send) [ -e "${box.root}/user-\${@: -1}" ] || exit 1; [ "$1" = -u ] && echo 990; [ "$1" = -nG ] && echo "\${@: -1}"; exit 0 ;;`,
        "esac",
        "echo 0",
      ].join("\n"),
    );
    box.fake("useradd", `${box.record("useradd")}\ntouch "${box.root}/user-\${@: -1}"`);
    box.fake("userdel", `${box.record("userdel")}\nrm -f "${box.root}/user-$1"`);
    box.fake("pkill", "exit 1");
    box.fake("getent", '[ -e "/etc/fake-group-$2" ] && exit 0\nexit 2');
    box.fake("groupadd", `${box.record("groupadd")}\ntouch "/etc/fake-group-\${@: -1}"`);
    box.fake("groupdel", box.record("groupdel"));
    box.fake(
      "install",
      `args=()\nwhile [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done\nexec /usr/bin/install "\${args[@]}"`,
    );
    box.fake(
      "curl",
      `${box.record("curl")}\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && : > "$2"; shift; done`,
    );
    box.fake("ss", "printf '%s\\n' 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*'");
    box.fake("nft", `if [ "$1" = -c ]; then ${nftCheck}; fi\nexit 0`);
    box.fake(
      "systemctl",
      `${box.record("systemctl")}\ncase "$1" in is-active) exit 3 ;; is-enabled) exit 1 ;; esac\nexit 0`,
    );
    box.fake(
      "sudo",
      `while [ "$1" != tar ]; do shift; done; mkdir -p "\${@: -1}"; echo config > "\${@: -1}/config.sh"`,
    );
    for (const name of ["visudo", "python3", "sshd"]) box.fake(name, "exit 0");
    box.fake("sha256sum", `cat > "${box.root}/sha-input"\nexit 0`);
    const inner = [
      "set -u",
      `real="${box.root}/real"`,
      'for dir in etc var usr; do mkdir -p "$real/$dir" && mount --rbind "/$dir" "$real/$dir" || exit 90; done',
      `mkdir -p "$real/scripts" && mount --bind "${scripts}" "$real/scripts" || exit 92`,
      "for dir in /etc /var /srv /usr/local; do mount -t tmpfs tmpfs $dir || exit 91; done",
      "keep() {",
      '  for entry in "$real/$1"/*; do',
      `    case " $2 " in *" \${entry##*/} "*) ;; *) ln -s "$entry" "/$1/\${entry##*/}" ;; esac`,
      "  done",
      "}",
      'keep etc "systemd sudoers.d gh-runner"',
      'keep var "backups lib"',
      "mkdir -p /etc/systemd/system /etc/sudoers.d /var/lib /usr/local/lib",
      `RUNNER_SITE=arm RUNNER_SEND_PUBLIC_KEY='${key}' RUNNER_SEND_FROM=192.0.2.9 bash "$real/scripts/install-runner.sh" > "${box.root}/stdout" 2> "${box.root}/stderr"`,
      'echo "rc=$?"',
      `for path in ${reported.join(" ")}; do`,
      '  if [ -d "$path" ]; then echo "$path=DIR"; elif [ -e "$path" ]; then echo "$path=$(tr \'\\n\' \'~\' < "$path")"; else echo "$path=MISSING"; fi',
      "done",
    ].join("\n");
    const result = spawnSync("bwrap", asRootInPrivateMounts(inner), {
      encoding: "utf8",
      env: { PATH: `${box.root}/bin:${process.env.PATH}`, HOME: box.root },
      maxBuffer: 64 * 1024 * 1024,
    });
    const state = Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    const text = (name) => readFileSync(path.join(box.root, name), "utf8");
    return { box, result, state, stdout: text("stdout"), stderr: text("stderr") };
  };

  it("installs two runners, the report account limited to one fixed command from the CI VPS, and no CI VPS slice", () => {
    const { box, state, stdout, stderr } = install("exit 0");
    expect([state.rc, stderr]).toEqual(["0", ""]);
    expect(stdout).toContain("INSTALL_OK site=arm ");
    expect(state["/var/lib/gh-ci-send/.ssh/authorized_keys"]).toBe(
      `restrict,from="192.0.2.9",command="/usr/local/lib/gh-runner/send-reports" ${key}~`,
    );
    const sender = state["/usr/local/lib/gh-runner/send-reports"];
    expect(sender).toContain('SHARE = "/srv/gh-runner-share"~');
    expect(sender).not.toContain("@SHARE@");
    expect(state["/etc/systemd/system/gh-runner-arm-1.service"]).toContain(
      "Slice=gh-arm-runners.slice~",
    );
    expect(state["/etc/systemd/system/gh-runner-arm-2.service"]).toContain("User=gh-runner-arm-2~");
    expect(state["/etc/systemd/system/gh-arm-runners.slice"]).toContain("MemoryMax=18G~");
    expect(state["/etc/systemd/system/gh-runners.slice"]).toBe("MISSING");
    expect(state["/etc/systemd/system/ghgate.slice"]).toBe("MISSING");
    expect(state["/etc/systemd/system/gh-runner-clean.service"]).toContain(
      "Environment=RUNNER_SITE=arm~ExecStart=/srv/gh-runner/hooks/clean-old.sh~",
    );
    expect(state["/srv/gh-runner/hooks/clean-old.sh"]).not.toBe("MISSING");
    expect(state["/srv/gh-runner-arm-1/hooks/job-started.sh"]).not.toBe("MISSING");
    expect(state["/srv/gh-runner-share"]).toBe("DIR");
    const calls = box.calls();
    expect(calls).toMatch(/^useradd .*--groups gh-ci-share .*--shell \/bin\/sh gh-ci-send$/m);
    expect(calls).toMatch(/^useradd .*--shell \/usr\/sbin\/nologin gh-runner-arm-1$/m);
    expect(calls).toMatch(/^curl .*actions-runner-linux-arm64-2\.338\.2\.tar\.gz$/m);
    expect(readFileSync(path.join(box.root, "sha-input"), "utf8")).toMatch(
      /^670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945 {2}/,
    );
  });

  it("takes the report account, its key and the runners away again when a later step fails", () => {
    const { box, state, stderr } = install("exit 1");
    expect(state.rc).not.toBe("0");
    expect(stderr).toContain("INSTALL_FAILED");
    for (const gone of [
      "/var/lib/gh-ci-send",
      "/usr/local/lib/gh-runner/send-reports",
      "/etc/systemd/system/gh-runner-arm-1.service",
      "/etc/systemd/system/gh-arm-runners.slice",
      "/srv/gh-runner-arm-2/runner",
      "/srv/gh-runner-share",
    ])
      expect([gone, state[gone]]).toEqual([gone, "MISSING"]);
    const calls = box.calls();
    for (const user of ["gh-ci-send", "gh-runner-arm-1", "gh-runner-arm-2"])
      expect(calls).toMatch(new RegExp(`^userdel ${user}$`, "m"));
  });
});

describe("[ADR-0266] pause, resume and fallback know about both machines", () => {
  const armBox = () => {
    const box = fiveRunners({ vpsNames: ["ci-arm-1", "ci-arm-2"] });
    box.set("service-states", "gh-runner-arm-1.service=active\ngh-runner-arm-2.service=active\n");
    return box;
  };
  const arm = { RUNNER_SITE: "arm", CI_ARM_SSH: "ubuntu@192.0.2.20" };

  it("RUNNER_SITE=arm pauses only the ARM runners, over ssh to the ARM machine with the site exported", () => {
    const box = armBox();
    const result = box.mac("pause-runners.sh", [], arm);
    expect(result.stdout).toContain(
      "RUNNER_PAUSED labels=removed services=stopped runners=ci-arm-1 ci-arm-2",
    );
    expect(result.status).toBe(0);
    expect(box.managedLabels()).toEqual({
      "ci-vps-1": ["ci-vps"],
      "ci-vps-2": ["ci-vps"],
      "ci-vps-gate": ["ci-vps-gate"],
      "ci-arm-1": [],
      "ci-arm-2": [],
      "ci-vps-3": ["ci-vps"],
    });
    const remote = box.lines().filter((line) => line.startsWith("ssh "));
    expect(remote.length).toBeGreaterThan(0);
    for (const line of remote)
      expect(line).toContain(
        'export RUNNER_SITE=arm; [ "$(uname -s)-$(uname -m)" = Linux-aarch64 ] ||',
      );
    const uploads = box.lines().filter((line) => line.startsWith("upload "));
    expect(uploads.length).toBeGreaterThan(0);
    for (const line of uploads) expect(line).toContain("ubuntu@192.0.2.20:");
  });

  it("RUNNER_SITE=arm resume puts ci-arm back on the ARM runners only", () => {
    const box = fiveRunners({
      runners: [
        [11, "ci-vps-1"],
        [12, "ci-vps-2"],
        [13, "ci-vps-gate"],
        [14, "ci-arm-1", []],
        [15, "ci-arm-2", []],
      ],
      vpsNames: ["ci-arm-1", "ci-arm-2"],
    });
    box.set("online-from", 1);
    const result = box.mac("resume-runners.sh", [], arm);
    expect(result.stdout).toContain("RUNNER_RESUMED labels=restored runners=ci-arm-1 ci-arm-2");
    expect(result.status).toBe(0);
    expect(box.managedLabels()["ci-arm-1"]).toEqual(["ci-arm"]);
    expect(box.managedLabels()["ci-arm-2"]).toEqual(["ci-arm"]);
    expect(box.lines().filter((line) => line.includes("-X POST"))).toHaveLength(2);
  });

  it("pausing the CI VPS leaves the ARM runners and their label alone", () => {
    const box = fiveRunners();
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(0);
    expect(box.managedLabels()["ci-arm-1"]).toEqual(["ci-arm"]);
    expect(box.managedLabels()["ci-vps-1"]).toEqual([]);
    for (const line of box.lines().filter((entry) => entry.startsWith("ssh ")))
      expect(line).not.toContain("RUNNER_SITE");
  });

  it("arm-fallback.sh on gives both CI VPS check runners the ci-arm label and off takes it away; the gate runner is never touched", () => {
    const box = fiveRunners();
    box.set("online-from", 1);
    const on = box.mac("arm-fallback.sh", ["on"]);
    expect(on.stdout).toContain(
      "ARM_FALLBACK_ON ci-vps-1 ci-vps-2 ci-vps-3 now also take ci-arm jobs",
    );
    expect(on.status).toBe(0);
    expect(box.managedLabels()).toEqual({
      "ci-vps-1": ["ci-vps", "ci-arm"],
      "ci-vps-2": ["ci-vps", "ci-arm"],
      "ci-vps-gate": ["ci-vps-gate"],
      "ci-arm-1": ["ci-arm"],
      "ci-arm-2": ["ci-arm"],
      "ci-vps-3": ["ci-vps", "ci-arm"],
    });
    const off = box.mac("arm-fallback.sh", ["off"]);
    expect(off.stdout).toContain(
      "ARM_FALLBACK_OFF ci-vps-1 ci-vps-2 ci-vps-3 take only ci-vps jobs",
    );
    expect(off.status).toBe(0);
    expect(box.managedLabels()["ci-vps-1"]).toEqual(["ci-vps"]);
    expect(box.managedLabels()["ci-vps-2"]).toEqual(["ci-vps"]);
    expect(box.managedLabels()["ci-arm-1"]).toEqual(["ci-arm"]);
    expect(existsSync(path.join(box.root, "lock"))).toBe(false);
  });

  it("arm-fallback.sh leaves out a check runner that is not installed yet and refuses when none is", () => {
    const twoChecks = [
      [11, "ci-vps-1"],
      [12, "ci-vps-2"],
      [13, "ci-vps-gate"],
      [14, "ci-arm-1"],
      [15, "ci-arm-2"],
    ];
    const box = fiveRunners({
      runners: twoChecks,
      vpsNames: ["ci-vps-1", "ci-vps-2", "ci-vps-gate"],
    });
    box.set("online-from", 1);
    const on = box.mac("arm-fallback.sh", ["on"]);
    expect(on.stdout).toContain("not installed on ci-vps, left out: ci-vps-3");
    expect(on.stdout).toContain("ARM_FALLBACK_ON ci-vps-1 ci-vps-2 now also take ci-arm jobs");
    expect(on.status).toBe(0);
    expect(box.managedLabels()["ci-vps-1"]).toEqual(["ci-vps", "ci-arm"]);
    expect(box.managedLabels()["ci-vps-2"]).toEqual(["ci-vps", "ci-arm"]);
    const off = box.mac("arm-fallback.sh", ["off"]);
    expect(off.stdout).toContain("ARM_FALLBACK_OFF ci-vps-1 ci-vps-2 take only ci-vps jobs");
    expect(off.status).toBe(0);
    const none = fiveRunners({
      runners: twoChecks.filter(([, name]) => !name.startsWith("ci-vps-")),
      vpsNames: ["ci-vps-gate"],
    });
    none.set("online-from", 1);
    const refused = none.mac("arm-fallback.sh", ["on"]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain("ARM_FALLBACK_FAILED ci-vps has no check runner installed");
    expect(none.lines().some((line) => line.includes("/labels"))).toBe(false);
  });

  it("arm-fallback.sh refuses when an installed check runner is missing on GitHub, and off also clears a runner that is no longer installed", () => {
    const missing = fiveRunners({
      runners: [
        [11, "ci-vps-1"],
        [12, "ci-vps-2"],
        [13, "ci-vps-gate"],
        [14, "ci-arm-1"],
        [15, "ci-arm-2"],
      ],
    });
    missing.set("online-from", 1);
    for (const mode of ["on", "off"]) {
      const result = missing.mac("arm-fallback.sh", [mode]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        "ARM_FALLBACK_FAILED GitHub has 0 runners named ci-vps-3, ci-vps has it installed; labels untouched",
      );
    }
    expect(missing.lines().some((line) => line.includes("/labels"))).toBe(false);
    const leftover = fiveRunners({
      runners: [
        [11, "ci-vps-1", ["ci-vps", "ci-arm"]],
        [12, "ci-vps-2", ["ci-vps", "ci-arm"]],
        [13, "ci-vps-gate"],
        [14, "ci-arm-1"],
        [15, "ci-arm-2"],
        [16, "ci-vps-3", ["ci-vps", "ci-arm"]],
      ],
      vpsNames: ["ci-vps-1", "ci-vps-2", "ci-vps-gate"],
    });
    const off = leftover.mac("arm-fallback.sh", ["off"]);
    expect(off.status).toBe(0);
    expect(off.stdout).toContain("not installed on ci-vps, left out: ci-vps-3");
    expect(leftover.managedLabels()["ci-vps-3"]).toEqual(["ci-vps"]);
    expect(leftover.managedLabels()["ci-vps-1"]).toEqual(["ci-vps"]);
    const stale = fiveRunners({
      runners: [
        [11, "ci-vps-1"],
        [12, "ci-vps-2"],
        [13, "ci-vps-gate"],
        [14, "ci-arm-1"],
        [15, "ci-arm-2"],
        [16, "ci-vps-3", ["ci-vps", "ci-arm"]],
      ],
      vpsNames: ["ci-vps-1", "ci-vps-2", "ci-vps-gate"],
    });
    stale.set("online-from", 1);
    const on = stale.mac("arm-fallback.sh", ["on"]);
    expect(on.status).toBe(1);
    expect(on.stdout).toContain(
      "ARM_FALLBACK_FAILED ci-vps-3 carries ci-arm but is not installed on ci-vps; run arm-fallback.sh off first; labels untouched",
    );
    expect(stale.lines().some((line) => line.includes("/labels"))).toBe(false);
    const allGone = fiveRunners({
      runners: [
        [11, "ci-vps-1", ["ci-vps", "ci-arm"]],
        [13, "ci-vps-gate"],
        [14, "ci-arm-1"],
        [15, "ci-arm-2"],
      ],
      vpsNames: ["ci-vps-gate"],
    });
    const strayOnly = allGone.mac("arm-fallback.sh", ["on"]);
    expect(strayOnly.status).toBe(1);
    expect(strayOnly.stdout).toContain(
      "ARM_FALLBACK_FAILED ci-vps-1 carries ci-arm but is not installed on ci-vps; run arm-fallback.sh off first",
    );
    const cleared = allGone.mac("arm-fallback.sh", ["off"]);
    expect(cleared.status).toBe(0);
    expect(cleared.stdout).toContain(
      "not installed on ci-vps, left out: ci-vps-1 ci-vps-2 ci-vps-3",
    );
    expect(allGone.managedLabels()["ci-vps-1"]).toEqual(["ci-vps"]);
    expect(cleared.stdout).toContain(
      "ARM_FALLBACK_OFF no check runner is installed on ci-vps and none carries ci-arm",
    );
  });

  it.each([
    ["scp-fail", "ARM_FALLBACK_FAILED labels untouched"],
    [
      "list-fail",
      "ARM_FALLBACK_FAILED could not list the runners installed on ci-vps; labels untouched",
    ],
  ])("arm-fallback.sh stops before touching any label when %s", (fault, message) => {
    for (const mode of ["on", "off"]) {
      const box = fiveRunners();
      box.set("online-from", 1);
      box.set(fault, "");
      const result = box.mac("arm-fallback.sh", [mode]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(message);
      expect(box.lines().some((line) => line.includes("/labels"))).toBe(false);
    }
  });

  it("arm-fallback.sh asks for on or off, refuses RUNNER_SITE=arm, and touches nothing in either case", () => {
    const box = fiveRunners();
    const usage = box.mac("arm-fallback.sh");
    expect(usage.status).toBe(64);
    expect(usage.stdout).toContain("usage");
    const wrongSite = box.mac("arm-fallback.sh", ["on"], arm);
    expect(wrongSite.status).toBe(64);
    expect(wrongSite.stdout).toContain("ARM_FALLBACK_FAILED run it without RUNNER_SITE");
    expect(box.calls()).toBe("");
  });

  it("arm-fallback.sh on is refused while the CI VPS runners are paused or all offline", () => {
    const paused = fiveRunners({ labelled: false });
    paused.set("online-from", 1);
    const first = paused.mac("arm-fallback.sh", ["on"]);
    expect(first.status).toBe(1);
    expect(first.stdout).toContain("run resume-runners.sh first; labels untouched");
    const offline = fiveRunners();
    offline.set("online-from", 99);
    const second = offline.mac("arm-fallback.sh", ["on"]);
    expect(second.status).toBe(1);
    expect(second.stdout).toContain("none of ci-vps-1 ci-vps-2 ci-vps-3 is online");
    for (const box of [paused, offline])
      expect(box.lines().some((line) => line.includes("/labels"))).toBe(false);
  });

  it("arm-fallback.sh reports failure when GitHub did not take or did not drop the label", () => {
    const box = fiveRunners();
    box.set("online-from", 1);
    box.set("fail-add-12", "");
    const on = box.mac("arm-fallback.sh", ["on"]);
    expect(on.status).toBe(1);
    expect(on.stdout).toContain(
      "ARM_FALLBACK_FAILED ci-arm is on: ci-vps-1 ci-vps-3 but should be on: ci-vps-1 ci-vps-2 ci-vps-3",
    );
    box.set("ignore-delete-11", "");
    const off = box.mac("arm-fallback.sh", ["off"]);
    expect(off.status).toBe(1);
    expect(off.stdout).toContain("ARM_FALLBACK_FAILED ci-arm is still on: ci-vps-1");
  });

  it("while the fallback is on, pausing the CI VPS is refused before any label is removed", () => {
    const box = fiveRunners({
      runners: [
        [11, "ci-vps-1", ["ci-vps", "ci-arm"]],
        [12, "ci-vps-2", ["ci-vps", "ci-arm"]],
        [13, "ci-vps-gate"],
        [14, "ci-arm-1"],
        [15, "ci-arm-2"],
        [16, "ci-vps-3", ["ci-vps", "ci-arm"]],
      ],
    });
    const result = box.mac("pause-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("RUNNER_PAUSE_FAILED ci-vps-1 also carries ci-arm");
    expect(result.stdout).toContain("run arm-fallback.sh off first");
    expect(
      box.lines().some((line) => line.includes("-X") || line.includes("--labels-removed")),
    ).toBe(false);
  });

  it("while the fallback is on, pausing the ARM site is refused because GitHub shows ci-arm on runners that are not on that machine", () => {
    const box = fiveRunners({
      runners: [
        [11, "ci-vps-1", ["ci-vps", "ci-arm"]],
        [12, "ci-vps-2"],
        [13, "ci-vps-gate"],
        [14, "ci-arm-1"],
        [15, "ci-arm-2"],
      ],
      vpsNames: ["ci-arm-1", "ci-arm-2"],
    });
    const result = box.mac("pause-runners.sh", [], arm);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ci-vps-1 carries ci-arm but is not installed on ci-arm");
    expect(box.lines().some((line) => line.includes("-X"))).toBe(false);
  });
});

describe("[ADR-0266] install-gate-remote.sh keeps the report key on the CI VPS", () => {
  const hostKey = `ssh-ed25519 ${"C".repeat(68)}`;
  const gateBox = () => {
    const box = sandbox();
    box.fake("hostname", "echo ci-vps");
    box.fake("id", 'case "$*" in "-u") echo 0 ;; *gh-runner-gate) exit 0 ;; *) echo 0 ;; esac');
    box.fake(
      "install",
      `args=()\nwhile [ $# -gt 0 ]; do case "$1" in -o|-g) printf 'owner %s %s\\n' "$2" "\${@: -1}" >> "${box.root}/calls"; shift 2 ;; *) args+=("$1"); shift ;; esac; done\nexec /usr/bin/install "\${args[@]}"`,
    );
    box.fake(
      "ssh-keygen",
      `${box.record("ssh-keygen")}\n[ "$1" = -y ] && { grep -qx PRIVATE "$3" && echo "ssh-ed25519 ${"D".repeat(68)}"; exit; }\nwhile [ $# -gt 1 ]; do shift; done\necho PRIVATE > "$1"\necho "ssh-ed25519 ${"D".repeat(68)} generated-comment" > "$1.pub"`,
    );
    box.fake(
      "sudo",
      `${box.record("sudo")}\necho "ssh: refused by fake" >&2\ncat "${box.root}/ssh-answer" 2> /dev/null\nexit "$(cat "${box.root}/ssh-status" 2> /dev/null || echo 0)"`,
    );
    const inRoot = (commands) => {
      const inner = [
        "set -u",
        `real="${box.root}/real"`,
        `mkdir -p "$real/scripts" && mount --bind "${scripts}" "$real/scripts" || exit 92`,
        'mkdir -p "$real/etc" && mount --rbind /etc "$real/etc" || exit 90',
        "mount -t tmpfs tmpfs /etc || exit 91",
        `for entry in "$real/etc"/*; do [ "\${entry##*/}" = gh-runner ] || ln -s "$entry" "/etc/\${entry##*/}"; done`,
        ...commands.map((command) =>
          command.startsWith("! ")
            ? command.slice(2)
            : `bash "$real/scripts/install-gate-remote.sh" ${command}; echo "rc=$?"`,
        ),
        'for file in /etc/gh-runner/remote-share/*; do [ -e "$file" ] && echo "$file=$(stat -c %a "$file"):$(cat "$file")"; done',
        'echo "dir=$(stat -c %a /etc/gh-runner/remote-share 2> /dev/null)"',
      ].join("\n");
      return spawnSync("bwrap", asRootInPrivateMounts(inner), {
        encoding: "utf8",
        env: { PATH: `${box.root}/bin:${process.env.PATH}`, HOME: box.root, TMPDIR: box.root },
      });
    };
    return { ...box, inRoot };
  };

  it("key creates the key once, readable by the gate runner only through its group, and prints the public half without the comment", () => {
    const box = gateBox();
    const result = box.inRoot(["key", "key"]);
    expect(result.stdout.match(/^GATE_REMOTE_KEY ssh-ed25519 D{68}$/gm)).toHaveLength(2);
    expect(result.stdout).toContain("/etc/gh-runner/remote-share/id_ed25519=440:PRIVATE");
    expect(result.stdout).toContain("dir=750");
    const calls = box.calls();
    expect(calls.match(/^ssh-keygen /gm)).toHaveLength(1);
    expect(calls).toMatch(/^owner root \/etc\/gh-runner\/remote-share\/id_ed25519$/m);
    expect(calls).toMatch(/^owner gh-runner-gate \/etc\/gh-runner\/remote-share\/id_ed25519$/m);
    expect(calls).toMatch(/^owner gh-runner-gate \/etc\/gh-runner\/remote-share$/m);
  });

  it("key derives the public half again from the kept private key when only the public file was lost", () => {
    const box = gateBox();
    const result = box.inRoot(["key", "! rm /etc/gh-runner/remote-share/id_ed25519.pub", "key"]);
    expect(result.stdout.match(/^rc=\d+$/gm)).toEqual(["rc=0", "rc=0"]);
    expect(result.stdout.match(/^GATE_REMOTE_KEY ssh-ed25519 D{68}$/gm)).toHaveLength(2);
    expect(result.stdout).toContain("/etc/gh-runner/remote-share/id_ed25519=440:PRIVATE");
    expect(result.stdout).toContain(
      `/etc/gh-runner/remote-share/id_ed25519.pub=444:ssh-ed25519 ${"D".repeat(68)}`,
    );
    const keygen = box.calls().match(/^ssh-keygen .*$/gm);
    expect(keygen).toHaveLength(2);
    expect(keygen[1]).toBe("ssh-keygen -y -f /etc/gh-runner/remote-share/id_ed25519");
  });

  it("trust records the address and pins the host key for exactly that address", () => {
    const box = gateBox();
    const result = box.inRoot(["key", `trust gh-ci-send@192.0.2.20 '${hostKey}'`]);
    expect(result.stdout).toContain("GATE_REMOTE_TRUSTED target=gh-ci-send@192.0.2.20");
    expect(result.stdout).toContain("/etc/gh-runner/remote-share/target=444:gh-ci-send@192.0.2.20");
    expect(result.stdout).toContain(
      `/etc/gh-runner/remote-share/known_hosts=444:192.0.2.20 ${hostKey}`,
    );
  });

  it("trust refuses an address or a host key that could smuggle ssh options, and refuses to run before key", () => {
    const box = gateBox();
    const result = box.inRoot([
      `trust gh-ci-send@192.0.2.20 '${hostKey}'`,
      "key",
      `trust '-oProxyCommand=id@192.0.2.20' '${hostKey}'`,
      `trust 'gh-ci-send@192.0.2.20 -oProxyCommand=id' '${hostKey}'`,
      `trust gh-ci-send@192.0.2.20 '${hostKey} extra'`,
      "trust gh-ci-send@192.0.2.20 'ssh-rsa AAAA'",
    ]);
    expect(result.stdout.match(/^rc=\d+$/gm)).toEqual([
      "rc=1",
      "rc=0",
      "rc=64",
      "rc=64",
      "rc=64",
      "rc=64",
    ]);
    expect(result.stderr).toContain("no key yet");
    expect(result.stdout).not.toContain("remote-share/target=");
    expect(result.stdout).not.toContain("remote-share/known_hosts=");
  });

  it("check passes only when the ARM machine answers through the fixed command that the report is missing", () => {
    const box = gateBox();
    writeFileSync(path.join(box.root, "ssh-answer"), '{"error": "MISSING"}\n');
    writeFileSync(path.join(box.root, "ssh-status"), "2");
    const ok = box.inRoot(["key", `trust gh-ci-send@192.0.2.20 '${hostKey}'`, "check"]);
    expect(ok.stdout).toContain(
      "GATE_REMOTE_OK gh-ci-send@192.0.2.20 answered through the fixed command",
    );
    const sudo = box
      .calls()
      .split("\n")
      .find((line) => line.startsWith("sudo "));
    expect(sudo).toContain("-u gh-runner-gate ssh -F none");
    expect(sudo).toContain("StrictHostKeyChecking=yes");
    expect(sudo).toContain("UserKnownHostsFile=/etc/gh-runner/remote-share/known_hosts");
    expect(sudo).toMatch(/ gh-ci-send@192\.0\.2\.20 1-1\/connection-check$/);

    for (const answer of ["Welcome to Ubuntu\n", ""]) {
      const bad = gateBox();
      writeFileSync(path.join(bad.root, "ssh-answer"), answer);
      writeFileSync(path.join(bad.root, "ssh-status"), answer ? "0" : "255");
      const result = bad.inRoot(["key", `trust gh-ci-send@192.0.2.20 '${hostKey}'`, "check"]);
      expect(result.stdout.match(/^rc=\d+$/gm)).toEqual(["rc=0", "rc=0", "rc=1"]);
      expect(result.stderr).toContain("GATE_REMOTE_FAILED status=");
      expect(result.stderr).toContain("ssh said: ssh: refused by fake");
      expect(result.stdout).not.toContain("GATE_REMOTE_OK");
      expect(readdirSync(bad.root).filter((name) => name.startsWith("tmp."))).toEqual([]);
    }
  });

  it("check refuses before key and trust; remove deletes everything", () => {
    const box = gateBox();
    const result = box.inRoot([
      "check",
      "key",
      `trust gh-ci-send@192.0.2.20 '${hostKey}'`,
      "remove",
    ]);
    expect(result.stdout.match(/^rc=\d+$/gm)).toEqual(["rc=1", "rc=0", "rc=0", "rc=0"]);
    expect(result.stdout).toContain("GATE_REMOTE_REMOVED");
    expect(result.stdout).toContain("dir=\n");
    expect(box.calls()).not.toMatch(/^sudo /m);
  });

  it("refuses the ARM site, other hosts, a missing gate account and unknown commands", () => {
    const box = sandbox();
    box.fake("hostname", "echo ci-vps");
    box.fake("uname", '[ "$1" = -s ] && echo Linux || echo aarch64');
    box.fake("id", '[ "$1" = -u ] && { echo 0; exit 0; }\nexit 1');
    for (const tool of ["install", "ssh-keygen"]) box.fake(tool, `${box.record(tool)}\nexit 0`);
    expect(box.run("install-gate-remote.sh", ["key"], { env: { RUNNER_SITE: "arm" } }).status).toBe(
      64,
    );
    expect(box.run("install-gate-remote.sh", ["bogus"]).status).toBe(64);
    expect(box.run("install-gate-remote.sh", []).stderr).toContain("usage");
    const noAccount = box.run("install-gate-remote.sh", ["key"]);
    expect(noAccount.status).toBe(69);
    expect(noAccount.stderr).toContain("gate runner account gh-runner-gate does not exist");
    box.fake("hostname", "echo laptop");
    expect(box.run("install-gate-remote.sh", ["key"]).status).toBe(68);
    expect(box.calls()).toBe("");
  });
});

describe("[ADR-0266] install-arm-runners.sh drives both machines from the Mac", () => {
  const sendKey = `ssh-ed25519 ${"E".repeat(68)}`;
  const hostKey = `ssh-ed25519 ${"F".repeat(68)}`;
  const orchestra = () => {
    const box = sandbox();
    const R = box.root;
    box.fake(
      "ssh",
      [
        'target=""; for argument; do case "$argument" in *@*) [ -z "$target" ] && target=$argument ;; esac; done',
        "for command; do :; done",
        `stdin=""; if [[ $command == *register-runner.sh* ]]; then stdin=$(cat); echo "$stdin" > "${R}/token-seen"; fi`,
        `printf 'ssh %s :: %s\\n' "$target" "$command" >> "${R}/calls"`,
        `step=$(cat "${R}/fail-on" 2> /dev/null); [ -n "$step" ] && [[ $command == *"$step"* ]] && exit 1`,
        'case "$command" in',
        `  *"install-gate-remote.sh key"*) echo "GATE_REMOTE_KEY ${sendKey}" ;;`,
        `  *ssh_host_ed25519_key.pub*) echo "${hostKey} root@arm" ;;`,
        `  *"is-active --quiet gh-runner-arm-1.service ||"*) [ -e "${R}/arm-running" ] || exit 3 ;;`,
        `  *"is-enabled --quiet gh-runner-arm-"*) [ -e "${R}/arm-registered" ] || exit 3 ;;`,
        "esac",
        "exit 0",
      ].join("\n"),
    );
    box.fake("scp", `printf 'upload %s\\n' "\${@: -1}" >> "${R}/calls"`);
    box.fake(
      "gh",
      [
        `printf 'gh %s\\n' "$*" >> "${R}/calls"`,
        'if [[ "$*" == *registration-token* ]]; then echo SECRET-REGISTRATION-TOKEN; exit 0; fi',
        `[ -e "${R}/never-online" ] && { printf 'ci-arm-1\\toffline\\tself-hosted,ci-arm\\n'; exit 0; }`,
        "printf 'ci-arm-1\\tonline\\tself-hosted,Linux,ARM64,ci-arm\\nci-arm-2\\tonline\\tself-hosted,Linux,ARM64,ci-arm\\nci-vps-1\\tonline\\tself-hosted,ci-vps\\n'",
      ].join("\n"),
    );
    box.fake("sleep", "exit 0");
    const set = (name, value = "") => writeFileSync(path.join(R, name), value);
    const go = (env = {}) =>
      box.run("install-arm-runners.sh", [], {
        env: {
          CI_VPS_SSH: "ubuntu@192.0.2.10",
          CI_ARM_SSH: "ubuntu@192.0.2.20",
          RUNNER_POLL_SECONDS: "0",
          ...env,
        },
      });
    const lines = () => box.calls().split("\n").filter(Boolean);
    return { ...box, set, go, lines };
  };

  it("prepares the ARM machine, exchanges the report key and the host key, registers both runners and waits until they are online", () => {
    const box = orchestra();
    const result = box.go();
    expect(result.stdout).toContain(
      "ARM_INSTALL_OK runners=ci-arm-1 ci-arm-2 label=ci-arm report_account=gh-ci-send@192.0.2.20; .github/workflows/ci.yml runs policy, static and security on it\n",
    );
    expect(result.status).toBe(0);
    const lines = box.lines();
    const at = (text) => lines.findIndex((line) => line.startsWith("ssh ") && line.includes(text));
    const order = [
      "prepare-arm.sh",
      "install-gate-remote.sh key",
      "install-runner.sh",
      "install-gate-remote.sh trust",
      "install-gate-remote.sh check",
      "register-runner.sh 4",
      "register-runner.sh 5",
    ].map(at);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(lines[at("install-runner.sh")]).toContain(
      `ssh ubuntu@192.0.2.20 :: [ "$(uname -s)-$(uname -m)" = Linux-aarch64 ] || { echo "not the ARM machine" >&2; exit 68; }; export RUNNER_SITE=arm; sudo RUNNER_SITE=arm RUNNER_SEND_PUBLIC_KEY='${sendKey}' RUNNER_SEND_FROM=192.0.2.10 bash`,
    );
    expect(lines[at("install-gate-remote.sh trust")]).toContain(
      `ssh ubuntu@192.0.2.10 :: [ "$(hostname)" = ci-vps ] ||`,
    );
    expect(lines[at("install-gate-remote.sh trust")]).toContain(
      `install-gate-remote.sh trust gh-ci-send@192.0.2.20 '${hostKey}'`,
    );
    const uploads = lines.filter((line) => line.startsWith("upload "));
    for (const name of [
      "send-reports.py",
      "prepare-arm.sh",
      "gh-arm-runners.slice",
      "gh-runner.service.in",
    ])
      expect(uploads).toContain(`upload ubuntu@192.0.2.20:/home/ubuntu/ci-runner/${name}`);
    expect(uploads).toContain(
      "upload ubuntu@192.0.2.10:/home/ubuntu/ci-runner/install-gate-remote.sh",
    );
    expect(
      uploads.some((line) => line.includes("192.0.2.10") && line.includes("install-runner.sh")),
    ).toBe(false);
  });

  it("every file the ARM install needs is in the upload list and exists", () => {
    const text = readFileSync(path.join(scripts, "install-arm-runners.sh"), "utf8");
    const listed = /^ARM_FILES="([^"]+)"$/m.exec(text)[1].split(" ");
    for (const name of listed)
      expect([name, existsSync(path.join(scripts, name))]).toEqual([name, true]);
    const installer = readFileSync(path.join(scripts, "install-runner.sh"), "utf8");
    const needed = [...installer.matchAll(/"\$SRC\/([A-Za-z0-9._-]+)"/g)].map((match) => match[1]);
    expect(needed.length).toBeGreaterThan(5);
    for (const name of needed)
      if (!["gh-runners.slice", "ghgate.slice"].includes(name)) expect(listed).toContain(name);
    expect(listed).toContain("gh-arm-runners.slice");
  });

  it("hands the registration token to the ARM machine on stdin, never on a command line", () => {
    const box = orchestra();
    expect(box.go().status).toBe(0);
    expect(readFileSync(path.join(box.root, "token-seen"), "utf8")).toBe(
      "SECRET-REGISTRATION-TOKEN\n",
    );
    expect(box.calls()).not.toContain("SECRET-REGISTRATION-TOKEN");
  });

  it("stops at the first failing step and does not register runners on GitHub", () => {
    for (const [step, number] of [
      ["prepare-arm.sh", 3],
      ["install-gate-remote.sh key", 4],
      ["install-runner.sh", 5],
      ["install-gate-remote.sh check", 6],
    ]) {
      const box = orchestra();
      box.set("fail-on", step);
      const result = box.go();
      expect([step, result.status]).toEqual([step, 1]);
      expect(result.stdout).toContain(`ARM_INSTALL_FAILED step=${number}:`);
      expect(result.stdout).not.toContain("ARM_INSTALL_OK");
      expect(box.calls()).not.toContain("registration-token");
      expect(
        box.lines().some((line) => line.startsWith("ssh ") && line.includes("register-runner.sh")),
      ).toBe(false);
    }
  });

  it("run again after it finished: skips the install and the registration, still checks the fetch", () => {
    const box = orchestra();
    box.set("arm-running");
    box.set("arm-registered");
    const result = box.go();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("the install is not repeated");
    expect(result.stdout).toContain("runner 4 is already registered and running");
    const calls = box.calls();
    expect(calls).not.toContain("bash /home/ubuntu/ci-runner/install-runner.sh");
    expect(calls).not.toContain("registration-token");
    expect(calls).toContain("install-gate-remote.sh check");
  });

  it("fails when the runners do not come online with the ci-arm label", () => {
    const box = orchestra();
    box.set("never-online");
    box.fake(
      "date",
      `n=$(( $(cat "${box.root}/date-count" 2> /dev/null || echo 0) + 1 )); echo $n > "${box.root}/date-count"; [ $n -le 1 ] && echo 1000 || echo 99999999`,
    );
    const result = box.go();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "ARM_INSTALL_FAILED step=8: not online with the ci-arm label after 3 minutes: ci-arm-1 ci-arm-2",
    );
  });

  it("refuses a CI VPS address that is not an IPv4 address, because the report key is pinned to it", () => {
    const box = orchestra();
    const result = box.go({ CI_VPS_SSH: "ubuntu@ci-vps.example" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ARM_INSTALL_FAILED step=1:");
    expect(box.calls()).not.toContain("prepare-arm.sh");
  });
});

describe("[ADR-0266] the sender and the fetcher agree, and the ARM site uninstalls cleanly", () => {
  it("send-reports.py and remote-share.mjs use the same limits and the same request shape", async () => {
    const sender = readFileSync(path.join(scripts, "send-reports.py"), "utf8");
    const number = (name) => {
      const expression = new RegExp(`^${name} = ([0-9* ]+)$`, "m").exec(sender)[1];
      return expression.split("*").reduce((product, factor) => product * Number(factor), 1);
    };
    const { REMOTE_LIMITS, REMOTE_SHARE_DIRECTORY } = await import(
      "../../scripts/ci/remote-share.mjs"
    );
    expect(number("MAX_FILES")).toBe(REMOTE_LIMITS.files);
    expect(number("MAX_FILE_BYTES")).toBe(REMOTE_LIMITS.fileBytes);
    expect(number("MAX_TOTAL_BYTES")).toBe(REMOTE_LIMITS.totalBytes);
    expect(REMOTE_LIMITS.responseBytes).toBeGreaterThan((REMOTE_LIMITS.totalBytes * 4) / 3);
    expect(shell('printf "%s" "$RUNNER_REMOTE_SHARE"').stdout).toBe(REMOTE_SHARE_DIRECTORY);
    expect(sender.startsWith("#!/usr/bin/python3 -I\n")).toBe(true);
    expect(sender).not.toMatch(/^\s*#(?!!)/m);
  });

  it("RUNNER_SITE=arm uninstall-runner.sh all removes both runners, the report account and its script", () => {
    const box = sandbox();
    box.fake("uname", '[ "$1" = -s ] && echo Linux || echo aarch64');
    for (const name of ["systemctl", "rm", "pkill", "groupdel"])
      box.fake(name, `${box.record(name)}\nexit 0`);
    box.fake("getent", "exit 2");
    box.fake("nft", '[ "$1" = list ] && exit 1\nexit 0');
    box.fake("userdel", `${box.record("userdel")}\ntouch "${box.root}/gone-$1"\nexit 0`);
    box.fake(
      "id",
      `[ -e "${box.root}/gone-\${@: -1}" ] && exit 1\n[ "$1" = -u ] && echo 0\nexit 0`,
    );
    const inner = [
      `scripts="${box.root}/scripts"`,
      `mkdir -p "$scripts" && mount --bind "${scripts}" "$scripts" || exit 92`,
      "for dir in /srv /etc /var/lib /usr/local; do mount -t tmpfs tmpfs $dir || exit 91; done",
      "mkdir -p /etc/systemd/system /etc/sudoers.d || exit 91",
      'RUNNER_SITE=arm exec bash "$scripts/uninstall-runner.sh" all',
    ].join("\n");
    const result = spawnSync("bwrap", asRootInPrivateMounts(inner), {
      encoding: "utf8",
      env: { PATH: `${box.root}/bin:${process.env.PATH}`, HOME: box.root },
    });
    expect(result.stderr, result.stderr).not.toContain("UNINSTALL_INCOMPLETE");
    const calls = box.calls();
    for (const user of ["gh-runner-arm-1", "gh-runner-arm-2", "gh-ci-send"])
      expect(calls).toContain(`userdel ${user}\n`);
    expect(calls).toContain("rm -rf /var/lib/gh-ci-send /usr/local/lib/gh-runner /srv/gh-runner\n");
    expect(calls).toMatch(/^rm -f \/etc\/systemd\/system\/gh-arm-runners\.slice /m);
    expect(calls).not.toContain("ghgate.slice");
    expect(result.stdout).toContain("UNINSTALL_OK removed: ci-arm-1 ci-arm-2;");
    expect(result.status).toBe(0);
    const single = box.run("uninstall-runner.sh", ["3"], { env: { RUNNER_SITE: "arm" } });
    expect(single.status).toBe(64);
  });
});

describe("runner machine preparation", () => {
  const repository = path.resolve(import.meta.dirname, "../..");
  const lock = JSON.parse(readFileSync(path.join(repository, "ci/toolchain-lock.json"), "utf8"));
  const playwright = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8"))
    .devDependencies["@playwright/test"];
  const value = (text, name) => text.match(new RegExp(`^${name}=(\\S+)$`, "mu"))?.[1];

  it.each([
    ["prepare-vps.sh", "linux-x64"],
    ["prepare-arm.sh", "linux-arm64"],
  ])(
    "%s installs the Chromium system libraries for the pinned Playwright and Node of %s",
    (name, platform) => {
      const text = readFileSync(path.join(scripts, name), "utf8");
      expect(text).toContain(`node-v$NODE_VERSION-${platform}.tar.gz`);
      expect(text).toContain(`node_bin="$work/node-v$NODE_VERSION-${platform}/bin"`);
      const node = lock.node.releases[value(text, "NODE_VERSION")]?.artifacts[platform];
      expect(value(text, "PLAYWRIGHT_VERSION")).toBe(playwright);
      expect(node.filename).toBe(`node-v${value(text, "NODE_VERSION")}-${platform}.tar.gz`);
      expect(value(text, "NODE_SHA256")).toBe(node.sha256);
      expect(text).toMatch(/playwright\/cli\.js" install-deps chromium\b/u);
    },
  );

  it("prepare-arm.sh gives integration tests the same sandbox tools and bwrap AppArmor profile as prepare-vps.sh", () => {
    const read = (name) => readFileSync(path.join(scripts, name), "utf8");
    const packages = (text) => text.match(/^apt-get install -y -q (.+)$/mu)?.[1].split(" ") ?? [];
    const profile = (text) => text.match(/^profile_text='([^']+)'$/mu)?.[1];
    const vps = read("prepare-vps.sh");
    const arm = read("prepare-arm.sh");
    for (const name of ["bubblewrap", "socat", "ripgrep", "apparmor-utils"]) {
      expect(packages(vps)).toContain(name);
      expect(packages(arm)).toContain(name);
    }
    expect(profile(arm)).toBeDefined();
    expect(profile(arm)).toBe(profile(vps));
    expect(arm).toContain('apparmor_parser -r "$APPARMOR_PROFILE"');
    expect(arm).toMatch(/^for tool in .*\bbwrap socat rg\b/mu);
  });
});
