import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DEVICE_ACTION_REGISTRATIONS,
  DEVICE_MIRROR_KIND_NAMES,
  type DeviceActionRegistration,
  PERCEPTION_PRODUCED_SENSES,
  PERCEPTION_PRODUCED_TYPE_NAMES,
  PERCEPTION_RECORD_TYPE_NAMES,
  PERCEPTION_UNPRODUCED_TYPES,
  type PerceptionRecordType,
} from "@himawari-agent/application";
import { describe, expect, it } from "vitest";

const appleSources = path.resolve(import.meta.dirname, "../../clients/apple/Sources");

interface AppleSide {
  readonly handled: ReadonlySet<string>;
  readonly readOnly: ReadonlySet<string>;
  readonly uploadedMirrors: ReadonlySet<string>;
}

function quoted(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"/gu)].map((match) => match[1] ?? "");
}

function appleSide(): AppleSide {
  const handled = new Set<string>();
  const readOnly = new Set<string>();
  const directory = path.join(appleSources, "HimawariActions");
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".swift"))) {
    const source = readFileSync(path.join(directory, file), "utf8");
    for (const list of source.matchAll(/public let names = \[([^\]]*)\]/gu))
      for (const name of quoted(list[1] ?? "")) handled.add(name);
    for (const list of source.matchAll(/public let readOnly: Set<String> = \[([^\]]*)\]/gu))
      for (const name of quoted(list[1] ?? "")) readOnly.add(name);
  }
  const senses = readFileSync(path.join(appleSources, "HimawariCore/Senses.swift"), "utf8");
  const mirrorBlock =
    /public var mirrorKind: String\? \{([\s\S]*?)\n {4}\}/u.exec(senses)?.[1] ?? "";
  const uploadedMirrors = new Set(
    [...mirrorBlock.matchAll(/case [^:]+: "([a-z_]+)"/gu)].map((match) => match[1] ?? ""),
  );
  return { handled, readOnly, uploadedMirrors };
}

function domainOf(name: string): string {
  return name.slice(0, name.indexOf("."));
}

function deviceCapabilityGaps(
  registrations: readonly DeviceActionRegistration[],
  apple: AppleSide,
): readonly string[] {
  const gaps: string[] = [];
  const byName = new Map(registrations.map((registration) => [registration.name, registration]));
  const domains = [...new Set(registrations.map(({ name }) => domainOf(name)))].sort();
  for (const domain of domains) {
    const members = registrations.filter(({ name }) => domainOf(name) === domain);
    const reads = members.filter(({ actionKind }) => actionKind === "READ");
    if (reads.length === 0)
      gaps.push(
        `${domain}: ${members.map(({ name }) => name).join(", ")} 只能改，没有读的动作（actionKind 为 READ）`,
      );
    for (const read of reads) {
      if (!apple.handled.has(read.name)) gaps.push(`${read.name}: 苹果端没有处理这个读动作`);
      else if (!apple.readOnly.has(read.name))
        gaps.push(`${read.name}: 苹果端没把它写进 readOnly，读结果没法核对`);
    }
  }
  for (const registration of registrations) {
    if (!registration.target) continue;
    const listed = registration.target.listedBy;
    if (listed) {
      if (byName.get(listed.action)?.actionKind !== "READ")
        gaps.push(`${registration.name}: listedBy 指向的 ${listed.action} 不是读动作`);
      continue;
    }
    if (!apple.uploadedMirrors.has(registration.target.mirrorKind))
      gaps.push(
        `${registration.name}: 目标要在 ${registration.target.mirrorKind} 副本里找，但苹果端从不上传这种副本，也没有 listedBy 读动作`,
      );
  }
  return gaps;
}

describe("[I-130] 每个设备能力都有读的路径", () => {
  it("注册表里的每个领域都能读，读动作苹果端接通并有测试，改动的目标都找得到", () => {
    expect(deviceCapabilityGaps(DEVICE_ACTION_REGISTRATIONS, appleSide())).toEqual([]);
  });

  it("拦得住这次日历的真实情况：只有建、改、删，没有读", () => {
    const before = DEVICE_ACTION_REGISTRATIONS.filter(
      ({ name, actionKind }) => !(domainOf(name) === "calendar" && actionKind === "READ"),
    ).map((registration) =>
      domainOf(registration.name) === "calendar" && registration.target
        ? {
            ...registration,
            target: {
              mirrorKind: registration.target.mirrorKind,
              idKey: registration.target.idKey,
            },
          }
        : registration,
    );
    const gaps = deviceCapabilityGaps(before, appleSide());
    expect(gaps).toContain(
      "calendar: calendar.create, calendar.delete, calendar.update 只能改，没有读的动作（actionKind 为 READ）",
    );
  });

  it("拦得住提醒事项“标成完成”：目标要在副本里找，但没人上传这种副本", () => {
    const apple = appleSide();
    const before = DEVICE_ACTION_REGISTRATIONS.map((registration) =>
      registration.name === "device_reminder.complete" && registration.target
        ? {
            ...registration,
            target: {
              mirrorKind: registration.target.mirrorKind,
              idKey: registration.target.idKey,
            },
          }
        : registration,
    );
    expect(apple.uploadedMirrors.has("reminder")).toBe(false);
    expect(deviceCapabilityGaps(before, apple)).toContain(
      "device_reminder.complete: 目标要在 reminder 副本里找，但苹果端从不上传这种副本，也没有 listedBy 读动作",
    );
  });

  it("苹果端能列出处理的动作和上传的副本，解析没有读空", () => {
    const apple = appleSide();
    expect(apple.handled.size).toBeGreaterThan(0);
    expect(apple.uploadedMirrors.size).toBeGreaterThan(0);
    for (const kind of apple.uploadedMirrors) expect(DEVICE_MIRROR_KIND_NAMES).toContain(kind);
  });
});

function swiftSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return swiftSources(full);
    return entry.name.endsWith(".swift") ? [readFileSync(full, "utf8")] : [];
  });
}

function recordTypesAppleProduces(): ReadonlySet<string> {
  const literals = new Set<string>();
  for (const source of swiftSources(appleSources))
    for (const match of source.matchAll(/"([a-z_]+\.[a-z_]+)"/gu)) literals.add(match[1] ?? "");
  return new Set(PERCEPTION_RECORD_TYPE_NAMES.filter((type) => literals.has(type)));
}

function perceptionListingGaps(
  unproduced: readonly PerceptionRecordType[],
  produced: ReadonlySet<string>,
): readonly string[] {
  const gaps: string[] = [];
  for (const type of PERCEPTION_RECORD_TYPE_NAMES) {
    const listed = !unproduced.includes(type);
    if (listed && !produced.has(type))
      gaps.push(`${type}: 列给模型可读，但没有任何客户端会产生这种记录`);
    if (!listed && produced.has(type))
      gaps.push(`${type}: 苹果端会产生这种记录，却标成了没人产生，模型读不到`);
  }
  return gaps;
}

describe("[I-130] 列给模型的感知种类都有客户端在产生", () => {
  it("每种列给模型的记录，苹果端代码里都有产生它的地方；没人产生的不列", () => {
    expect(perceptionListingGaps(PERCEPTION_UNPRODUCED_TYPES, recordTypesAppleProduces())).toEqual(
      [],
    );
    expect(PERCEPTION_PRODUCED_TYPE_NAMES.length).toBeGreaterThan(0);
    expect(PERCEPTION_PRODUCED_SENSES).not.toContain("surroundings");
    expect(PERCEPTION_PRODUCED_SENSES).toContain("location");
  });

  it("拦得住这次的真实情况：电量、专注模式、正在播放等全部列给模型，却没有客户端产生", () => {
    const gaps = perceptionListingGaps([], recordTypesAppleProduces());
    expect(gaps).toContain("context.power: 列给模型可读，但没有任何客户端会产生这种记录");
    expect(gaps).toContain("screen.text: 列给模型可读，但没有任何客户端会产生这种记录");
    expect(gaps).toHaveLength(PERCEPTION_UNPRODUCED_TYPES.length);
  });

  it("反向：把真在产生的种类标成没人产生，也会被拦", () => {
    expect(perceptionListingGaps(["location.visit"], recordTypesAppleProduces())).toContain(
      "location.visit: 苹果端会产生这种记录，却标成了没人产生，模型读不到",
    );
  });
});
