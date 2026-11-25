import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { MAC_PRESENCE_WINDOW_SECONDS } from "../../apps/agent-service/src/mac-placement.ts";

const appleSources = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../clients/apple/Sources",
);
const source = readFileSync(path.join(appleSources, "HimawariCore/OwnerPresence.swift"), "utf8");

function declared(pattern: RegExp): number {
  const value = pattern.exec(source)?.[1];
  expect(value, String(pattern)).toBeDefined();
  return Number(value);
}

const shortestWindowPattern = /static let shortestServerWindow: TimeInterval = (\d+(?:\.\d+)?)\n/u;

it("Mac 定上报节奏时按的窗口不长于服务端判断 Mac 在场的窗口", () => {
  expect(declared(shortestWindowPattern)).toBeLessThanOrEqual(MAC_PRESENCE_WINDOW_SECONDS);
});

it("实际生效的上报间隔加一次检查间隔和网络余量，不超过服务端允许的最短窗口", () => {
  const minimumInterval = declared(
    /static let standard = PresenceReportPolicy\(minimumInterval: (\d+(?:\.\d+)?), keepAliveInterval: \d+(?:\.\d+)?\)\n/u,
  );
  expect(source).toContain("let tick = max(minimumInterval / 4, 1)");
  const check = Math.max(minimumInterval / 4, 1);
  const networkAllowance = 10;
  expect(minimumInterval + check + networkAllowance).toBeLessThanOrEqual(
    declared(shortestWindowPattern),
  );
});

it("Mac 实际用的上报策略就是 standard，没有别处另给一套间隔", () => {
  const swiftFiles = readdirSync(appleSources, {
    recursive: true,
    encoding: "utf8",
  })
    .filter((name) => name.endsWith(".swift"))
    .map((name) => ({
      name,
      text: readFileSync(path.join(appleSources, name), "utf8"),
    }));
  const policiesBuilt = swiftFiles.flatMap(({ name, text }) =>
    [...text.matchAll(/PresenceReportPolicy\(minimumInterval:/gu)].map(() => name),
  );
  expect(policiesBuilt).toEqual([path.join("HimawariCore", "OwnerPresence.swift")]);
  const sensor = swiftFiles.find(({ name }) => name.endsWith("PresenceSensor.swift"))?.text ?? "";
  expect(sensor).toContain("init(app: AppModel, policy: PresenceReportPolicy = .standard)");
  const sensorsBuilt = swiftFiles.flatMap(({ text }) =>
    [...text.matchAll(/PresenceSensor\(([^)]*)\)/gu)].map((match) => match[1]),
  );
  expect(sensorsBuilt).toEqual(["app: model.app"]);
});
