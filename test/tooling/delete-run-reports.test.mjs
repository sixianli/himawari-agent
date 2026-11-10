import { describe, expect, it } from "vitest";
import { deleteRunReports } from "../../scripts/ci/delete-run-reports.mjs";

function fakeGitHub(artifacts) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? "GET" });
    if ((options.method ?? "GET") === "GET") {
      const page = Number(new URL(url).searchParams.get("page"));
      return {
        ok: true,
        status: 200,
        json: async () => ({ artifacts: artifacts.slice((page - 1) * 100, page * 100) }),
      };
    }
    return { ok: true, status: 204 };
  };
  return { calls, fetchImpl };
}
const base = { repository: "o/r", runId: "7", attempt: "1", token: "t" };

describe("汇总通过后删除本次运行的报告产物", () => {
  it("只删本次运行本次尝试的 report-，不碰 gate、diagnostic 和别的运行", async () => {
    const { calls, fetchImpl } = fakeGitHub([
      { id: 1, name: "report-7-1-build-default" },
      { id: 2, name: "report-7-1-browser-default" },
      { id: 3, name: "gate-7-1" },
      { id: 4, name: "diagnostic-7-1-build-default" },
      { id: 5, name: "report-7-2-build-default" },
      { id: 6, name: "report-70-1-build-default" },
    ]);
    const deleted = await deleteRunReports({ ...base, fetchImpl });
    expect(deleted).toEqual(["report-7-1-build-default", "report-7-1-browser-default"]);
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.url)).toEqual([
      "https://api.github.com/repos/o/r/actions/artifacts/1",
      "https://api.github.com/repos/o/r/actions/artifacts/2",
    ]);
  });

  it("没有报告时什么都不删", async () => {
    const { calls, fetchImpl } = fakeGitHub([{ id: 3, name: "gate-7-1" }]);
    expect(await deleteRunReports({ ...base, fetchImpl })).toEqual([]);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("超过一页时继续翻页", async () => {
    const artifacts = Array.from({ length: 150 }, (_, i) => ({ id: i, name: `report-7-1-x${i}` }));
    const { fetchImpl } = fakeGitHub(artifacts);
    expect(await deleteRunReports({ ...base, fetchImpl })).toHaveLength(150);
  });

  it("删除失败要报错，已被删掉(404)不算失败", async () => {
    const failing = async (_url, options = {}) =>
      options.method === "DELETE"
        ? { ok: false, status: 500 }
        : { ok: true, json: async () => ({ artifacts: [{ id: 1, name: "report-7-1-a" }] }) };
    await expect(deleteRunReports({ ...base, fetchImpl: failing })).rejects.toThrow("500");
    const gone = async (_url, options = {}) =>
      options.method === "DELETE"
        ? { ok: false, status: 404 }
        : { ok: true, json: async () => ({ artifacts: [{ id: 1, name: "report-7-1-a" }] }) };
    await expect(deleteRunReports({ ...base, fetchImpl: gone })).resolves.toHaveLength(1);
  });

  it("拒绝不合法的仓库名、运行号和缺少令牌", async () => {
    await expect(deleteRunReports({ ...base, repository: "o/r/../x" })).rejects.toThrow();
    await expect(deleteRunReports({ ...base, runId: "7/../8" })).rejects.toThrow();
    await expect(deleteRunReports({ ...base, token: "" })).rejects.toThrow();
  });
});
