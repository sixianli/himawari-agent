import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTROL_CENTER_SURFACE_INVENTORY } from "../../apps/control-center/src/app/control-center-inventory.ts";
import {
  DEVICE_REFERENCE_PLACEHOLDER,
  SERVER_FILLED_PAYLOAD_KEYS,
} from "../../packages/platform-node/src/device-gateway.ts";
import {
  APPROVAL_ALLOWANCE_DAYS_MAXIMUM,
  APPROVAL_ALLOWANCE_DAYS_MINIMUM,
  CLIENT_CAPABILITY_TABLE,
  CLIENT_GATEWAY_MESSAGE_TYPES,
  CLIENT_GATEWAYS,
  CLIENT_PAGE_TABLE,
  CLIENT_RESPONSE_ONLY_TYPES,
  MEMORY_TRASH_RETENTION_DAYS,
  type ClientCapabilityEntry,
  type ClientPageEntry,
} from "../../packages/gateway-contracts/src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SWIFT_FILE = "clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift";
const WRITE = process.env["HIMAWARI_WRITE_CLIENT_PARITY"] === "1";

function swiftString(value: string): string {
  return JSON.stringify(value);
}

function camel(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part.length > 0)
    .map((part, index) => (index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join("");
}

const GATEWAY_CASES: Readonly<Record<ClientCapabilityEntry["gateway"], string>> = {
  v1: "v1",
  v2: "v2",
  "thread-v3": "threadV3",
};
const TIER_CASES: Readonly<Record<ClientCapabilityEntry["tier"], string>> = {
  read: "read",
  routine: "routine",
  tighten: "tighten",
  change: "change",
  not_on_phone: "notOnPhone",
};

function capabilityLine(entry: ClientCapabilityEntry): string {
  const tighten = entry.tightenPayload
    ? `[${Object.entries(entry.tightenPayload)
        .map(([key, value]) => `${swiftString(key)}: ${value}`)
        .join(", ")}]`
    : "nil";
  const open = `[${(entry.tightenOpenKeys ?? []).map(swiftString).join(", ")}]`;
  const every = entry.tightenEveryItem
    ? `ClientItemTighten(key: ${swiftString(entry.tightenEveryItem.key)}, equals: [${Object.entries(
        entry.tightenEveryItem.equals,
      )
        .map(([key, value]) => `${swiftString(key)}: ${swiftString(value)}`)
        .join(
          ", ",
        )}], nulls: [${entry.tightenEveryItem.nulls.map(swiftString).join(", ")}], openKeys: [${entry.tightenEveryItem.openKeys.map(swiftString).join(", ")}])`
    : "nil";
  return `        ClientCapability(gateway: .${GATEWAY_CASES[entry.gateway]}, type: ${swiftString(entry.type)}, kind: .${entry.kind}, tier: .${TIER_CASES[entry.tier]}, tightenPayload: ${tighten}, tightenOpenKeys: ${open}, tightenEveryItem: ${every}),`;
}

function nativePages(pages: readonly ClientPageEntry[]): string[] {
  return [
    ...new Set(pages.flatMap((page) => ("nativePage" in page ? [page.nativePage] : []))),
  ].sort();
}

function renderSwift(
  capabilities: readonly ClientCapabilityEntry[],
  pages: readonly ClientPageEntry[],
): string {
  return `import Foundation

public enum ClientGateway: String, Sendable, CaseIterable {
    case v1 = "v1"
    case v2 = "v2"
    case threadV3 = "thread-v3"
}

public enum ClientRequestKind: String, Sendable {
    case query
    case command
}

public enum ClientCapabilityTier: String, Sendable {
    case read
    case routine
    case tighten
    case change
    case notOnPhone = "not_on_phone"
}

public struct ClientItemTighten: Sendable, Hashable {
    public let key: String
    public let equals: [String: String]
    public let nulls: [String]
    public let openKeys: [String]

    func accepts(_ payload: JSONValue) -> Bool {
        guard case .object(let fields) = payload, fields.count == 1, case .array(let items)? = fields[key], !items.isEmpty else {
            return false
        }
        let expectedKeys = Set(equals.keys).union(nulls).union(openKeys)
        return items.allSatisfy { item in
            guard case .object(let entry) = item, Set(entry.keys) == expectedKeys else { return false }
            return equals.allSatisfy { entry[$0.key] == JSONValue.string($0.value) }
                && nulls.allSatisfy { entry[$0] == JSONValue.null }
        }
    }
}

public struct ClientCapability: Sendable, Hashable {
    public let gateway: ClientGateway
    public let type: String
    public let kind: ClientRequestKind
    public let tier: ClientCapabilityTier
    public let tightenPayload: [String: Bool]?
    public let tightenOpenKeys: [String]
    public let tightenEveryItem: ClientItemTighten?

    public func requiredTier(payload: JSONValue) -> ClientCapabilityTier {
        if let tightenEveryItem, tightenEveryItem.accepts(payload) { return .tighten }
        guard
            let tightenPayload,
            Set(tightenOpenKeys).isSubset(of: payload.keys),
            let flags = payload.flags(ignoring: tightenOpenKeys)
        else { return tier }
        return flags == tightenPayload ? .tighten : tier
    }
}

public enum NativePage: String, Sendable, CaseIterable {
${nativePages(pages)
  .map((page) => `    case ${camel(page)} = ${swiftString(page)}`)
  .join("\n")}
}

public enum ClientCapabilities {
    public static let all: [ClientCapability] = [
${capabilities.map(capabilityLine).join("\n")}
    ]

    public static let referencePlaceholder = ${swiftString(DEVICE_REFERENCE_PLACEHOLDER)}
    public static let serverFilledReferences = [${SERVER_FILLED_PAYLOAD_KEYS.map(swiftString).join(", ")}]
    public static let allowanceDays: ClosedRange<Int> = ${APPROVAL_ALLOWANCE_DAYS_MINIMUM}...${APPROVAL_ALLOWANCE_DAYS_MAXIMUM}
    public static let memoryTrashDays = ${MEMORY_TRASH_RETENTION_DAYS}

    public static func find(_ gateway: ClientGateway, _ type: String) -> ClientCapability? {
        all.first { $0.gateway == gateway && $0.type == type }
    }
}
`;
}

describe("[第11批] check:client-parity 网页和手机不能悄悄不一致", () => {
  it("网页的每个页面在手机上有对应的原生页，或写明手机上不做的原因", () => {
    const web = CONTROL_CENTER_SURFACE_INVENTORY.map((surface) => surface.id).sort();
    const table = CLIENT_PAGE_TABLE.map((page) => page.webPage);
    expect(new Set(table).size).toBe(table.length);
    expect([...table].sort()).toEqual(web);
    for (const page of CLIENT_PAGE_TABLE) {
      if ("notOnPhone" in page) expect(page.notOnPhone.length).toBeGreaterThan(0);
      else expect(page.nativePage).toMatch(/^[a-z]+(\.[a-z]+)*$/u);
    }
  });

  it("网页页面用到的每种查询和命令都在客户端能力表里", () => {
    const registered = new Set(CLIENT_CAPABILITY_TABLE.map((entry) => entry.type));
    const used = CONTROL_CENTER_SURFACE_INVENTORY.flatMap((surface) => [
      ...surface.queries,
      ...surface.mutations,
    ]);
    expect(used.filter((type) => !registered.has(type))).toEqual([]);
  });

  it("能力表只登记合约里的查询和命令，对话那份和旧的那份重名只算一次", () => {
    const contract = new Set(
      CLIENT_GATEWAYS.flatMap((gateway) =>
        CLIENT_GATEWAY_MESSAGE_TYPES[gateway].filter(
          (type) => !CLIENT_RESPONSE_ONLY_TYPES[gateway].includes(type),
        ),
      ),
    );
    const table = new Set(CLIENT_CAPABILITY_TABLE.map((entry) => entry.type));
    expect([...table].filter((type) => !contract.has(type))).toEqual([]);
    expect([...contract].filter((type) => !table.has(type))).toEqual([]);
  });

  it("每个原生页面在能力表里至少对上一种类型，对不上的要写明原因", () => {
    const registered = new Set(
      CLIENT_CAPABILITY_TABLE.filter((entry) => entry.tier !== "not_on_phone").map(
        (entry) => entry.type,
      ),
    );
    for (const page of CLIENT_PAGE_TABLE) {
      if (!("nativePage" in page)) continue;
      const surface = CONTROL_CENTER_SURFACE_INVENTORY.find((item) => item.id === page.webPage);
      const types = [...(surface?.queries ?? []), ...(surface?.mutations ?? [])].filter((type) =>
        registered.has(type),
      );
      if (page.noGatewayTypes === undefined)
        expect(types.length, page.nativePage).toBeGreaterThan(0);
      else {
        expect(page.noGatewayTypes.length).toBeGreaterThan(0);
        expect(types, page.nativePage).toEqual([]);
      }
    }
  });

  it("Swift 的消息清单和原生页清单由能力表生成，没有手改", () => {
    const expected = renderSwift(CLIENT_CAPABILITY_TABLE, CLIENT_PAGE_TABLE);
    const file = path.join(root, SWIFT_FILE);
    if (WRITE) writeFileSync(file, expected);
    expect(readFileSync(file, "utf8")).toBe(expected);
  });

  it("生成的 Swift 跟着能力表变：表里加一种类型而文件没重生成就对不上", () => {
    const extra: ClientCapabilityEntry = {
      gateway: "v2",
      type: "memory.example.added",
      kind: "query",
      tier: "read",
    };
    expect(renderSwift([...CLIENT_CAPABILITY_TABLE, extra], CLIENT_PAGE_TABLE)).not.toBe(
      readFileSync(path.join(root, SWIFT_FILE), "utf8"),
    );
  });
});
