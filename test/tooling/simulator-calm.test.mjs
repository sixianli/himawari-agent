import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "../../clients/apple/scripts/simulator-calm.sh");
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeTools(loads) {
  const dir = mkdtempSync(join(tmpdir(), "simulator-calm-"));
  dirs.push(dir);
  writeFileSync(join(dir, "loads"), `${loads.join("\n")}\n`);
  writeFileSync(join(dir, "count"), "0");
  writeFileSync(
    join(dir, "ps"),
    `#!/usr/bin/env bash
case "$*" in
  *comm=*) echo "4242 777 $(tail -1 "${dir}/loads") SpringBoard" ;;
  *)
    n=$(cat "${dir}/count"); echo $((n + 1)) > "${dir}/count"
    load=$(sed -n "$((n + 1))p" "${dir}/loads"); [ -n "$load" ] || load=$(tail -1 "${dir}/loads")
    echo "4242 $load"
    echo "1 99.0" ;;
esac
`,
  );
  writeFileSync(join(dir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(dir, "ps"), 0o755);
  chmodSync(join(dir, "sleep"), 0o755);
  return dir;
}

function waitUntilCalm(loads) {
  const dir = fakeTools(loads);
  try {
    const stdout = execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail; simulator_launchd=4242; . "${script}"; wait_until_calm 2>"${dir}/err"; echo "required=$calm_required"; calm && echo calm || echo busy`,
      ],
      { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
    );
    return {
      status: 0,
      stdout,
      stderr: execFileSync("cat", [join(dir, "err")], { encoding: "utf8" }),
    };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

describe("截图前等模拟器安静（I-261128-2qvz）", () => {
  it("负载一直在上限之上（GitHub Mac 上 79% 的真实情形）时不让截图失败，改为只看场景标记和连拍相同", () => {
    const result = waitUntilCalm(["79.0"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("required=0\ncalm\n");
    expect(result.stderr).toContain("UI_REVIEW_BUSY 777 79.0 SpringBoard");
    expect(result.stderr).toContain("UI_REVIEW_STILL_BUSY simulator load stayed at 79% for 180s");
  });

  it("负载降下来时照旧等它连续三次低于上限，之后每张图仍要求安静", () => {
    const result = waitUntilCalm(["90.0", "70.0", "12.0", "11.0", "10.0", "95.0"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("required=1\nbusy\n");
    expect(result.stderr).toBe("");
  });

  it("只数这台模拟器的进程，别的进程忙不算", () => {
    const result = waitUntilCalm(["5.0"]);
    expect(result.stdout).toBe("required=1\ncalm\n");
  });
});
