import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { observeResources } from "../../scripts/ci/resources.mjs";

const roots = [];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "himawari-resource-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("记录实际分配磁盘的采样峰值下界，不重复计入仓库内工具", async () => {
  const root = fixture();
  const toolsDirectory = path.join(root, "tools");
  mkdirSync(toolsDirectory);
  writeFileSync(path.join(root, "input"), Buffer.alloc(4096, 1));
  const stop = await observeResources({ root, toolsDirectory, intervalMs: 2 });
  writeFileSync(path.join(toolsDirectory, "download"), Buffer.alloc(128 * 1024, 2));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const report = await stop();
  expect(report.status).toBe("measured");
  expect(report.peakIsLowerBound).toBe(true);
  expect(report.scopes).toHaveLength(1);
  expect(report.scopes[0].samples).toBeGreaterThanOrEqual(2);
  expect(report.scopes[0].peakBytes).toBeGreaterThan(report.scopes[0].firstBytes);
  expect(report.scopes[0].lastBytes).toBe(report.scopes[0].peakBytes);
  expect(report.hardware.cpus).toBeGreaterThan(0);
  expect(JSON.stringify(report)).not.toContain(root);
});

it("仓库外的工具单独计量，缺失目录明确记录不完整", async () => {
  const root = fixture();
  const toolsDirectory = fixture();
  const stop = await observeResources({ root, toolsDirectory });
  rmSync(toolsDirectory, { recursive: true });
  const report = await stop();
  expect(report.status).toBe("incomplete");
  expect(report.scopes.map((scope) => scope.label)).toEqual(["workspace", "tools"]);
  expect(report.errors).toEqual(["tools:1"]);
});

it("未提供工具目录仍有完整起止采样", async () => {
  const stop = await observeResources({ root: fixture() });
  const report = await stop();
  expect(report.scopes[0].samples).toBe(2);
  expect(Date.parse(report.completedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
});
