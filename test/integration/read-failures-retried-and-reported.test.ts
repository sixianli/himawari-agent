import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEVICE_READ_PROBLEM_SOURCES } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import {
  harness,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
} from "../fixtures/device-api-harness.ts";
import { devicePost } from "../fixtures/perception-test-client.ts";

afterEach(removeDeviceHarnessDirectories);

const appleSources = path.resolve(import.meta.dirname, "../../clients/apple/Sources");
const READ_PROBLEMS_FILE = path.join(appleSources, "HimawariCore/ReadProblems.swift");
const SENSES = path.join(appleSources, "HimawariSenses");
const READ_CALLS = [
  "enumerateContacts",
  ".result(for:",
  "executeQuery",
  "mirror.sync(",
  "queue.flush(",
  "queue.add(",
];

function swiftReadProblemSources(source: string): Map<string, string> {
  const body = /public enum ReadProblemSource[^{]*\{([\s\S]*?)\n\}/u.exec(source)?.[1] ?? "";
  const cases = new Map<string, string>();
  for (const match of body.matchAll(/case (\w+)(?: = "([^"]+)")?/gu))
    cases.set(match[1] ?? "", match[2] ?? match[1] ?? "");
  return cases;
}

function swallowedReads(file: string, source: string): string[] {
  return source
    .split("\n")
    .flatMap((line, index) =>
      /try\?/u.test(line) && READ_CALLS.some((call) => line.includes(call))
        ? [`${file}:${index + 1}: ${line.trim()}`]
        : [],
    );
}

function senseFiles(): { readonly file: string; readonly source: string }[] {
  return readdirSync(SENSES)
    .filter((name) => name.endsWith(".swift"))
    .map((name) => ({
      file: `HimawariSenses/${name}`,
      source: readFileSync(path.join(SENSES, name), "utf8"),
    }));
}

describe("[I-130] when Himawari cannot read what the owner allowed, it retries and tells developers, not the owner", () => {
  it("the iPhone and the server name the same read sources", () => {
    const swift = swiftReadProblemSources(readFileSync(READ_PROBLEMS_FILE, "utf8"));
    expect(swift.size).toBeGreaterThan(0);
    expect([...swift.values()].sort()).toEqual([...DEVICE_READ_PROBLEM_SOURCES].sort());
  });

  it("every read source is reported somewhere when it fails", () => {
    const swift = swiftReadProblemSources(readFileSync(READ_PROBLEMS_FILE, "utf8"));
    const callers = senseFiles()
      .map(({ source }) => source)
      .join("\n");
    const silent = [...swift.keys()].filter(
      (name) => !new RegExp(`\\.failed\\(\\.${name}\\b`, "u").test(callers),
    );
    expect(silent).toEqual([]);
  });

  it("no sense swallows a failed read or upload with try?", () => {
    expect(senseFiles().flatMap(({ file, source }) => swallowedReads(file, source))).toEqual([]);
  });

  it("[reverse] catches the reads that used to fail silently: contacts wiped the server copy, mirror uploads and queued health records were dropped", () => {
    expect(
      swallowedReads(
        "ContactsCollector.swift",
        "        try? CNContactStore().enumerateContacts(with: request) { contact, _ in",
      ),
    ).toHaveLength(1);
    expect(
      swallowedReads(
        "SenseSink.swift",
        "        _ = try? await mirror.sync(kind: kind, entries: fitted, batchSize: batch, forceFull: forceFull)",
      ),
    ).toHaveLength(1);
    expect(
      swallowedReads("SenseSink.swift", "            try? await queue.add(upload)"),
    ).toHaveLength(1);
    expect(
      swallowedReads(
        "HealthCollector.swift",
        "        guard let sleeps = try? await sleep.result(for: store) else { return false }",
      ),
    ).toHaveLength(1);
    const unreported = swiftReadProblemSources(
      "public enum ReadProblemSource: String {\n    case health\n    case calendar\n}",
    );
    expect(
      [...unreported.keys()].filter(
        (name) =>
          !new RegExp(`\\.failed\\(\\.${name}\\b`, "u").test("problems.failed(.health, code: c)"),
      ),
    ).toEqual(["calendar"]);
  });

  it("a device's report of a read that keeps failing reaches the service log, at most once a minute per source", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const report = { source: "health", code: "HEALTH_5", failures: 3, sinceSeconds: 90 };
    const first = await devicePost(h, client, "read-problems", report);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await devicePost(h, client, "read-problems", { ...report, failures: 4 })).status).toBe(
      200,
    );
    expect(
      (
        await devicePost(h, client, "read-problems", {
          ...report,
          source: "perception_upload",
          code: "HTTP_503",
        })
      ).status,
    ).toBe(200);
    expect(h.warnings.filter((warning) => warning.event === "device.read_failed")).toEqual([
      { event: "device.read_failed", deviceId: client.deviceId, ...report },
      {
        event: "device.read_failed",
        deviceId: client.deviceId,
        ...report,
        source: "perception_upload",
        code: "HTTP_503",
      },
    ]);
    await h.app.close();
    await h.repository.close();
  });

  it("[reverse] refuses a report with an unknown source, free text as its code, or extra fields", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const report = { source: "health", code: "HEALTH_5", failures: 3, sinceSeconds: 90 };
    for (const body of [
      { ...report, source: "calendar" },
      { ...report, code: "读不到健康数据" },
      { ...report, failures: 0 },
      { ...report, sinceSeconds: -1 },
      { ...report, note: "x" },
      {},
    ]) {
      const refused = await devicePost(h, client, "read-problems", body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
    expect(h.warnings.filter((warning) => warning.event === "device.read_failed")).toEqual([]);
    await h.app.close();
    await h.repository.close();
  });
});
