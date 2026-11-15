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

it("Mac 上报在场的节奏按服务端 macPresenceSeconds 允许的最短窗口来定", () => {
  const declared = /static let shortestServerWindow: TimeInterval = (\d+)\b/u.exec(source)?.[1];
  expect(declared).toBeDefined();
  expect(Number(declared)).toBe(DELIVERY_TIMING_RANGES.macPresenceSeconds[0]);
});
