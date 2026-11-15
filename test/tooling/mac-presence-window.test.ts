import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { DELIVERY_TIMING_RANGES } from "../../packages/application/src/services/delivery-timing.ts";

const source = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../clients/apple/Sources/HimawariCore/OwnerPresence.swift",
  ),
  "utf8",
);

const shortestWindow = DELIVERY_TIMING_RANGES.macPresenceSeconds[0];

function declared(pattern: RegExp): number {
  const value = pattern.exec(source)?.[1];
  expect(value, String(pattern)).toBeDefined();
  return Number(value);
}

it("Mac 上报在场的节奏按服务端 macPresenceSeconds 允许的最短窗口来定", () => {
  expect(declared(/static let shortestServerWindow: TimeInterval = (\d+(?:\.\d+)?)\n/u)).toBe(
    shortestWindow,
  );
});

it("实际生效的上报间隔加一次检查间隔和网络余量，不超过服务端允许的最短窗口", () => {
  const minimumInterval = declared(
    /static let standard = PresenceReportPolicy\(minimumInterval: (\d+(?:\.\d+)?), keepAliveInterval: \d+(?:\.\d+)?\)\n/u,
  );
  expect(source).toContain("let tick = max(minimumInterval / 4, 1)");
  const check = Math.max(minimumInterval / 4, 1);
  const networkAllowance = 10;
  expect(minimumInterval + check + networkAllowance).toBeLessThanOrEqual(shortestWindow);
});
