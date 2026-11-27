import { describe, expect, it } from "vitest";
import { failureLines } from "../../scripts/ci/run.mjs";

const result = (status) => ({ checkId: "tests", matrixKey: "integration-1", status });

describe("检查没通过时把原因打进作业日志", () => {
  it("infrastructure_failed 时列出出错的命令和失败原因，不用再去翻已过期的缓存", () => {
    expect(
      failureLines(result("infrastructure_failed"), {
        commands: [
          { name: "install", exitCode: 0 },
          { name: "vitest-integration", exitCode: 143, termination: "timeout" },
          { name: "probe", exitCode: 127, error: "ENOENT" },
        ],
        failures: ["CI_COMMAND_FAILED:vitest-integration", "CI_TEMP_CLEANUP_FAILED:EBUSY"],
      }),
    ).toEqual([
      "CI_CHECK_STATUS tests/integration-1 infrastructure_failed",
      "CI_CHECK_COMMAND vitest-integration exit=143 termination=timeout",
      "CI_CHECK_COMMAND probe exit=127 error=ENOENT",
      "CI_CHECK_FAILURE CI_COMMAND_FAILED:vitest-integration",
      "CI_CHECK_FAILURE CI_TEMP_CLEANUP_FAILED:EBUSY",
    ]);
  });

  it("通过时什么都不打，读不到详情时至少打出状态", () => {
    expect(failureLines(result("passed"), { commands: [], failures: ["x"] })).toEqual([]);
    expect(failureLines(result("failed"), null)).toEqual([
      "CI_CHECK_STATUS tests/integration-1 failed",
    ]);
  });
});
