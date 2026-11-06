import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linuxRunnerLabel } from "../../scripts/ci/contracts.mjs";

const scripts = path.resolve(import.meta.dirname, "../../scripts/operations/ci-runner");
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
  const labels = (on) => `self-hosted,Linux,X64${on ? ",ci-vps" : ""}`;
  writeFileSync(
    path.join(R, "runners.tsv"),
    runners.map(([id, name]) => `${id}\t${name}\toffline\tfalse\t${labels(labelled)}\n`).join(""),
  );
  writeFileSync(path.join(R, "vps-names"), vpsNames.map((name) => `${name}\n`).join(""));
  const relabel = (on) =>
    `awk -F'\\t' -v OFS='\\t' -v id="$id" '$1 == id { $5 = "${labels(on)}" } 1' "${R}/runners.tsv" > "${R}/t" && mv "${R}/t" "${R}/runners.tsv"`;
  box.fake(
    "gh",
    [
      `printf 'gh %s\\n' "$*" >> "${R}/calls"`,
      'args="$*"',
      "if [[ $args == */labels* ]]; then",
      `  id=$(sed -E 's#.*/runners/([0-9]+)/labels.*#\\1#' <<< "$args")`,
      '  if [[ $args == *"-X DELETE"* ]]; then',
      `    [ -e "${R}/interrupt-delete-$id" ] && { kill -TERM $PPID; exit 1; }`,
      `    [ -e "${R}/fail-delete-$id" ] && exit 1`,
      `    [ -e "${R}/ignore-delete-$id" ] && exit 0`,
      `    ${relabel(false)}`,
      `    [ -e "${R}/interrupt-after-delete-$id" ] && kill -TERM $PPID`,
      "  else",
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
  box.fake("scp", `printf 'upload %s\\n' "$*" >> "${R}/calls"`);
  box.fake(
    "ssh",
    [
      "for command; do :; done",
      `printf 'ssh %s\\n' "$command" >> "${R}/calls"`,
      'case "$command" in',
      `  *--list) cat "${R}/vps-names" ;;`,
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
  const mac = (script) =>
    spawnSync("/bin/bash", [path.join(scripts, script)], {
      encoding: "utf8",
      env: {
        PATH: `${box.root}/bin:${process.env.PATH}`,
        HOME: R,
        RUNNER_LOCK_DIR: path.join(R, "lock"),
        RUNNER_POLL_SECONDS: "0",
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
  const lines = () => box.calls().split("\n").filter(Boolean);
  return { ...box, set, late, mac, labelState, lines };
};

describe("[HR-11] runner 名字和标签", () => {
  it("注册用的标签和主机就是 CI 工作流要的 ci-vps", () => {
    const runners = readFileSync(path.join(scripts, "runners.sh"), "utf8");
    expect(runners).toContain(`RUNNER_LABEL=${linuxRunnerLabel}\n`);
    expect(runners).toContain("RUNNER_HOST=ci-vps\n");
    expect(runners).toContain("RUNNER_NAME=ci-vps-1\n");
    expect(runners).toContain("RUNNER_NAME=ci-vps-2\n");
    expect(readFileSync(path.join(scripts, "register-runner.sh"), "utf8")).toContain(
      '--labels "$RUNNER_LABEL"',
    );
    expect(readFileSync(path.join(scripts, "mac-runners.sh"), "utf8")).toContain(
      "LABEL=$RUNNER_LABEL\n",
    );
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
      "RUNNER_PAUSE_FAILED ci-vps still on: ci-vps-2; put back on: 11",
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
  it("starts the services, waits for GitHub to see them online, then puts the label back", () => {
    const box = macBox({ labelled: false });
    box.set("online-from", 3);
    const result = box.mac("resume-runners.sh");
    expect(result.stdout).toContain("RUNNER_RESUMED labels=restored");
    expect(result.status).toBe(0);
    expect(box.labelState()).toEqual({ "ci-vps-1": true, "ci-vps-2": true });
    const order = box.lines();
    const start = order.findIndex((line) => line.includes("runner-resume.sh"));
    const firstAdd = order.findIndex((line) => line.includes("-X POST"));
    expect(start).toBeLessThan(firstAdd);
    expect(
      order.slice(start, firstAdd).filter((line) => line.endsWith("@tsv")).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("changes nothing when the runners on the VPS and GitHub do not match", () => {
    const box = macBox({ labelled: false, runners: [[11, "ci-vps-1"]] });
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("RUNNER_RESUME_FAILED GitHub has 0 runners named ci-vps-2");
    expect(
      box
        .lines()
        .some(
          (line) =>
            (line.startsWith("ssh ") && line.includes("runner-resume.sh")) ||
            line.includes("-X POST"),
        ),
    ).toBe(false);
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

  it("leaves the labels off and reports each service when the services do not start", () => {
    const box = macBox({ labelled: false });
    box.set("resume-fail", "");
    box.set("service-states", "gh-runner.service=active\ngh-runner-2.service=failed\n");
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "RUNNER_RESUME_FAILED services=gh-runner.service=active gh-runner-2.service=failed",
    );
    expect(box.lines().some((line) => line.includes("-X POST"))).toBe(false);
  });

  it("leaves the labels off when the runners never come online", () => {
    const box = macBox({ labelled: false });
    box.set("online-from", 9999);
    box.late();
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(
      "RUNNER_RESUME_INCOMPLETE services=gh-runner.service=active gh-runner-2.service=active labels=removed",
    );
    expect(box.lines().some((line) => line.includes("-X POST"))).toBe(false);
  });

  it("reports services and each label when interrupted while putting labels back", () => {
    const box = macBox({ labelled: false });
    box.set("interrupt-after-add-11", "");
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(130);
    expect(result.stdout).toContain(
      "RUNNER_RESUME_INCOMPLETE interrupted services=gh-runner.service=active gh-runner-2.service=active labels: ci-vps-1=on ci-vps-2=off",
    );
  });

  it("reports services and labels when interrupted while waiting for the runners to come online", () => {
    const box = macBox({ labelled: false });
    box.set("online-from", 9999);
    box.set("interrupt-sleep", "");
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(130);
    expect(result.stdout).toContain(
      "RUNNER_RESUME_INCOMPLETE interrupted services=gh-runner.service=active gh-runner-2.service=active labels: ci-vps-1=off ci-vps-2=off",
    );
    expect(box.lines().some((line) => line.includes("-X POST"))).toBe(false);
  });

  it("says GitHub could not be read instead of calling the runners offline", () => {
    const box = macBox({ labelled: false });
    box.set("fail-list-from", 2);
    box.late();
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("offline: (could not read GitHub)");
  });

  it("reports the runner whose label could not be put back", () => {
    const box = macBox({ labelled: false });
    box.set("fail-add-12", "");
    const result = box.mac("resume-runners.sh");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("labels: ci-vps-1=on ci-vps-2=off");
    expect(box.labelState()).toEqual({ "ci-vps-1": true, "ci-vps-2": false });
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

  it("gives both runners all cores and 14 GB together with default priority on a CI-only host", () => {
    expect(slice()).toMatchObject({
      MemoryHigh: "19G",
      MemoryMax: "20G",
      MemorySwapMax: "0",
      TasksMax: "4096",
    });
    for (const key of ["CPUQuota", "CPUWeight", "IOWeight"]) {
      expect(slice()).not.toHaveProperty(key);
    }
    expect(bytes(slice().MemoryHigh)).toBeLessThan(bytes(slice().MemoryMax));
  });

  it.each([
    [1, "gh-runner", "/srv/gh-runner", "/srv/gh-runner-2", "ci-vps-1"],
    [2, "gh-runner-2", "/srv/gh-runner-2", "/srv/gh-runner", "ci-vps-2"],
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
        MemoryHigh: "14G",
        MemoryMax: "15G",
        MemorySwapMax: "0",
        TasksMax: "2048",
        ProtectProc: "invisible",
        ReadWritePaths: `${root}/runner ${root}/home ${root}/logs`,
      });
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

  it("gives both runners the same hardening apart from their own paths and names", () => {
    const normalize = (id, text) =>
      text
        .replaceAll(id === 1 ? "ci-vps-1" : "ci-vps-2", "NAME")
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
    "/etc/systemd/system/gh-runners.slice",
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
  ];

  const installWithFailingRuleCheck = (nftCheck, extraSetup = []) => {
    const box = sandbox();
    box.fake("hostname", "echo ci-vps");
    box.fake(
      "id",
      [
        `case "\${@: -1}" in`,
        '  gh-runner) [ "$1" = -u ] && echo 996; [ "$1" = -nG ] && echo gh-runner; exit 0 ;;',
        `  gh-runner-2) [ -e "${box.root}/user-gh-runner-2" ] || exit 1; [ "$1" = -u ] && echo 995; [ "$1" = -nG ] && echo gh-runner-2; exit 0 ;;`,
        "esac",
        "echo 0",
      ].join("\n"),
    );
    box.fake("useradd", `${box.record("useradd")}\ntouch "${box.root}/user-gh-runner-2"`);
    box.fake("userdel", `${box.record("userdel")}\nrm -f "${box.root}/user-$1"`);
    box.fake("pkill", `${box.record("pkill")}\nexit 1`);
    box.fake("getent", "exit 2");
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
      `bash "$real/scripts/install-runner.sh" > "${box.root}/stdout" 2> "${box.root}/stderr"`,
      'echo "rc=$?"',
      `for path in ${reported.join(" ")}; do`,
      '  if [ -d "$path" ]; then echo "$path=DIR"; elif [ -e "$path" ]; then echo "$path=$(cat "$path")"; else echo "$path=MISSING"; fi',
      "done",
    ].join("\n");
    const result = spawnSync("unshare", ["-rm", "/bin/bash", "-c", inner], {
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
    const { result, state, stderr } = installWithFailingRuleCheck("exit 0");
    expect(result.status).toBe(0);
    expect(stderr).not.toContain("INSTALL_FAILED");
    expect(state.rc).toBe("0");
    expect(state["/srv/gh-runner/bin/runner-pause.sh"]).toBe("MISSING");
    expect(state["/srv/gh-runner/bin/runner-resume.sh"]).toBe("MISSING");
    expect(state["/srv/gh-runner/hooks/job-started.sh"]).not.toBe("old-hook");
    expect(state["/srv/gh-runner/bin"]).toBe("MISSING");
  });

  it.each([
    ["a failed step", "exit 1", "1"],
    ["a TERM signal", "kill -TERM $PPID; exit 0", "130"],
  ])("puts every file back and deletes the new account after %s", (_, nftCheck, code) => {
    const { box, result, state, stderr } = installWithFailingRuleCheck(nftCheck);
    expect(result.status).toBe(0);
    expect(state.rc).toBe(code);
    expect(stderr).toContain("INSTALL_FAILED");
    expect(stderr).not.toContain("RESTORE_INCOMPLETE");
    expect(stderr).not.toContain("command not found");
    expect(stderr).not.toContain("unbound variable");
    expect(readFileSync(path.join(box.root, "stdout"), "utf8")).toBe("");
    expect(box.calls()).toMatch(/^nft -c -f /m);
    expect(box.calls()).not.toMatch(/^systemctl (enable|is-enabled) /m);
    expect(box.calls()).toMatch(/^useradd .*gh-runner-2$/m);
    expect(box.calls()).toMatch(/^userdel gh-runner-2$/m);
    expect(box.calls()).toMatch(/^nft -f \/etc\/gh-runner\/nft.rules$/m);
    expect(state).toEqual({
      rc: code,
      "/etc/systemd/system/gh-runner.service": "old-unit",
      "/etc/systemd/system/gh-runner-2.service": "MISSING",
      "/etc/systemd/system/gh-runners.slice": "MISSING",
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
    const result = spawnSync("unshare", ["-rm", "/bin/bash", "-c", inner], {
      encoding: "utf8",
      env: { PATH: `${box.root}/bin:${process.env.PATH}`, HOME: box.root },
    });
    expect(result.stderr).not.toContain("UNINSTALL_INCOMPLETE");
    expect(result.status).toBe(0);
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
      "ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl start gh-runner.service, /usr/bin/systemctl stop gh-runner.service, /usr/bin/systemctl restart gh-runner.service\n",
    );
  });
});
