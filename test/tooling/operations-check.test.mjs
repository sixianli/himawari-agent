import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkOperations, readContractOperations } from "../../scripts/check-operations.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const contract = `export const GATEWAY_V2_MESSAGE_TYPES = [
  "demo.read",
  "demo.write",
  "demo.snapshot",
] as const;
const a = object({ ...envelope("query", "demo.read") });
const b = object({ ...commandEnvelope("demo.write") });
const c = object({ ...envelope("snapshot", "demo.snapshot") });
`;

function tree(files, ledger = {}, notInstalled = {}) {
  const root = mkdtempSync(join(tmpdir(), "operations-check-"));
  roots.push(root);
  const all = {
    "packages/gateway-contracts/src/contracts-v2.ts": contract,
    "ci/operations-pending.json": JSON.stringify({ operations: ledger, notInstalled }),
    "ci/operations-removed.json": JSON.stringify({ removed: {} }),
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    if (text === null) continue;
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const complete = {
  "apps/agent-service/src/handler.ts": `if (m.type === "demo.read") {}\nif (m.type === "demo.write") {}`,
  "apps/control-center/src/page.ts": `send("demo.read"); send("demo.write");`,
  "apps/agent-service/test/handler.test.ts": `"demo.read"; "demo.write";`,
};

const gatewayFile = "apps/agent-service/src/production-approval-gateway.ts";
const compositionFile = "apps/agent-service/src/production-http-composition.ts";
const demoList = `export const PRODUCTION_DEMO_OPERATIONS = Object.freeze(["demo.read", "demo.write"] as const);
export function demoControl() { return (m) => { if (m.type === "demo.read") {} if (m.type === "demo.write") {} }; }`;

function gateway({
  query = 'query.type.startsWith("demo.")',
  command = 'command.type.startsWith("demo.")',
  option = "demoControl",
  list = "PRODUCTION_DEMO_OPERATIONS",
} = {}) {
  return `
const reads = { query: (query) => ${query} && options.${option} ? options.${option}.query(query) : fallback.query(query) };
const plane = { execute: async ({ command }) => { if (${command} && options.${option}) return options.${option}.execute(command); return fallback.set(command); } };
const service = { installedOperations: [ ...(options.${option} ? ${list} : []) ] };
`;
}
const composition = `const browser = { installedGatewayV2Operations: [ ...PRODUCTION_DEMO_OPERATIONS ] };`;
const baseInventory = `export function isSurfaceInstalled(surface) { return surface.id === "threads"; }
export const CONTROL_CENTER_SURFACE_INVENTORY = [
  {
    id: "demo",
    queries: ["demo.read"],
    mutations: ["demo.write"],
  },
];`;
const inventoryFile = "apps/control-center/src/app/control-center-inventory.ts";
const wired = {
  ...complete,
  [inventoryFile]: baseInventory,
  "apps/agent-service/src/production-demo.ts": demoList,
  [gatewayFile]: gateway(),
  [compositionFile]: composition,
};

describe("operations check", () => {
  it("reads queries and commands but not snapshots", () => {
    expect(readContractOperations(contract).operations).toEqual([
      { name: "demo.read", kind: "query" },
      { name: "demo.write", kind: "command" },
    ]);
  });

  it("passes when every operation has an implementation, a caller and a test", () => {
    expect(checkOperations(tree(complete)).errors).toEqual([]);
  });

  it("[P1-4] reports an operation with no backend implementation", () => {
    const files = {
      ...complete,
      "apps/agent-service/src/handler.ts": `if (m.type === "demo.read") {}`,
    };
    expect(checkOperations(tree(files)).errors).toEqual([
      "OPERATION_INCOMPLETE demo.write 缺：后端实现",
    ]);
  });

  it("[P1-4] does not count a label of the same name or the contract itself as a caller", () => {
    const files = {
      ...complete,
      "apps/control-center/src/page.ts": `send("demo.read"); label(message("demo.write"));`,
      "apps/control-center/src/i18n/resources/zh.ts": `"demo.write": "写"`,
    };
    expect(checkOperations(tree(files)).errors).toEqual([
      "OPERATION_INCOMPLETE demo.write 缺：调用方",
    ]);
  });

  it("[P1-4] does not count a fixture as a test", () => {
    const files = {
      ...complete,
      "apps/agent-service/test/handler.test.ts": `"demo.read";`,
      "packages/gateway-contracts/test/gateway-v2.fixture.ts": `"demo.write"`,
      "apps/control-center/test/fixtures/messages.json": `"demo.write"`,
    };
    expect(checkOperations(tree(files)).errors).toEqual([
      "OPERATION_INCOMPLETE demo.write 缺：测试",
    ]);
  });

  it("[P1-4] accepts a pending operation with a reason and rejects one that has become complete", () => {
    const missing = { ...complete, "apps/control-center/src/page.ts": `send("demo.read");` };
    const reason = "后端已实现，前端还没有页面";
    expect(checkOperations(tree(missing, { "demo.write": reason })).errors).toEqual([]);
    expect(checkOperations(tree(complete, { "demo.write": reason })).errors).toEqual([
      "OPERATION_PENDING_BUT_COMPLETE demo.write 已齐全，从 operations 移除（ci/operations-pending.json）",
    ]);
  });

  it("[P1-4] rejects a pending entry without a reason or for an unknown operation", () => {
    const missing = { ...complete, "apps/control-center/src/page.ts": `send("demo.read");` };
    expect(
      checkOperations(tree(missing, { "demo.write": "x", "demo.gone": "已经不在约定里的操作" }))
        .errors,
    ).toEqual([
      "OPERATION_PENDING_REASON_MISSING demo.write",
      "OPERATION_PENDING_NOT_IN_CONTRACT demo.gone",
    ]);
  });

  it("[P1-4] rejects an installed operation that the contract does not define", () => {
    const files = {
      ...complete,
      "apps/agent-service/src/production-demo.ts": `export const PRODUCTION_DEMO_OPERATIONS = Object.freeze(["demo.read", "demo.ghost"] as const);`,
      [gatewayFile]: gateway(),
      [compositionFile]: composition,
      [inventoryFile]: baseInventory,
    };
    expect(checkOperations(tree(files)).errors).toEqual([
      "OPERATION_DECLARED_NOT_INSTALLED demo.write (demo)",
      "OPERATION_INSTALLED_NOT_IN_CONTRACT demo.ghost (PRODUCTION_DEMO_OPERATIONS in apps/agent-service/src/production-demo.ts)",
    ]);
  });

  it("does not let the installed list itself stand in for the implementation", () => {
    const files = {
      ...complete,
      "apps/agent-service/src/handler.ts": `if (m.type === "demo.read") {}`,
      "apps/agent-service/src/production-demo.ts": `export const PRODUCTION_DEMO_OPERATIONS = Object.freeze(["demo.write"] as const);`,
      [gatewayFile]: gateway(),
      [compositionFile]: composition,
      [inventoryFile]: baseInventory,
    };
    expect(checkOperations(tree(files)).errors).toEqual([
      "OPERATION_HANDLER_MISSING demo.write (apps/agent-service/src/production-demo.ts 里没有处理它的代码)",
      "OPERATION_DECLARED_NOT_INSTALLED demo.read (demo)",
      "OPERATION_INCOMPLETE demo.write 缺：后端实现",
    ]);
  });

  it("[P1-4] rejects a deleted operation that code or tests still use", () => {
    const name = `${"session"}.revoke`;
    const removed = {
      "ci/operations-removed.json": JSON.stringify({ removed: { [name]: "gone" } }),
    };
    const expected = [`OPERATION_REMOVED_STILL_USED ${name}`];
    const withFile = (file, text) => tree({ ...complete, ...removed, [file]: text });
    for (const text of [
      `const m = { type: "${name}" };`,
      `send("${name}");`,
      `case "${name}":`,
      `rpc.message("${name}")`,
      `{ type: \`${name}\` }`,
    ])
      expect(
        checkOperations(withFile("packages/integration-github/test/github.test.ts", text)).errors,
      ).toEqual(expected);
    expect(
      checkOperations(
        withFile(
          "apps/control-center/src/app/label.ts",
          `message("${name}"); timings.measure(id, "${name}", run);`,
        ),
      ).errors,
    ).toEqual([]);
    expect(checkOperations(tree({ ...complete, ...removed })).errors).toEqual([]);
    expect(
      checkOperations(tree({ ...complete, "ci/operations-removed.json": null })).errors,
    ).toEqual(["OPERATIONS_REMOVED_LEDGER_MISSING"]);
  });

  it("[P1-4] rejects a deleted operation or snapshot that returns to the contract", () => {
    const revived = {
      ...complete,
      "ci/operations-removed.json": JSON.stringify({
        removed: { "demo.read": "gone", "demo.snapshot": "gone" },
      }),
    };
    expect(checkOperations(tree(revived)).errors).toEqual([
      "OPERATION_REMOVED_BUT_IN_CONTRACT demo.read",
      "OPERATION_REMOVED_STILL_USED demo.read",
      "OPERATION_REMOVED_BUT_IN_CONTRACT demo.snapshot",
      "OPERATION_REMOVED_STILL_USED demo.snapshot",
    ]);
  });

  it("[四处一致] passes when contract, installed list, route and handler agree", () => {
    expect(checkOperations(tree(wired)).errors).toEqual([]);
  });

  it("[四处一致] reports an installed command with no route branch", () => {
    const files = {
      ...wired,
      [gatewayFile]: gateway({ command: 'command.type === "demo.other"' }),
    };
    expect(checkOperations(tree(files)).errors).toEqual([
      "OPERATION_NOT_ROUTED demo.write (PRODUCTION_DEMO_OPERATIONS，command)",
    ]);
  });

  it("[四处一致] reports an installed query with no route branch", () => {
    const files = {
      ...wired,
      [gatewayFile]: gateway({ query: 'query.type.startsWith("other.")' }),
    };
    expect(checkOperations(tree(files)).errors).toEqual([
      "OPERATION_NOT_ROUTED demo.read (PRODUCTION_DEMO_OPERATIONS，query)",
    ]);
  });

  it("[四处一致] reports an operation routed to another handler first", () => {
    const stolen = gateway().replace(
      "const plane =",
      'const first = (command) => command.type.startsWith("demo.") && options.otherControl ? 1 : 2;\nconst plane =',
    );
    const files = { ...wired, [gatewayFile]: stolen };
    expect(checkOperations(tree(files)).errors).toEqual([
      "OPERATION_ROUTED_TO_OTHER_HANDLER demo.write 走到 otherControl，应为 demoControl",
    ]);
  });

  it("[四处一致] reports an installed operation whose handler code is missing", () => {
    const files = {
      ...wired,
      "apps/agent-service/src/production-demo.ts": demoList.replace(
        'if (m.type === "demo.write") {}',
        "",
      ),
      "apps/agent-service/src/handler.ts": `if (m.type === "demo.read") {}`,
      "apps/agent-service/test/handler.test.ts": `"demo.read"; "demo.write";`,
    };
    expect(checkOperations(tree(files)).errors).toEqual(
      expect.arrayContaining([
        "OPERATION_HANDLER_MISSING demo.write (apps/agent-service/src/production-demo.ts 里没有处理它的代码)",
      ]),
    );
  });

  it("[四处一致] reports a list that is defined but never installed or not advertised", () => {
    const unused = {
      ...wired,
      [gatewayFile]: gateway().replace("PRODUCTION_DEMO_OPERATIONS", "PRODUCTION_OTHER_OPERATIONS"),
    };
    expect(checkOperations(tree(unused)).errors).toEqual(
      expect.arrayContaining([
        "OPERATION_LIST_NOT_INSTALLED PRODUCTION_DEMO_OPERATIONS in apps/agent-service/src/production-demo.ts",
      ]),
    );
    const hidden = {
      ...wired,
      [compositionFile]: "const browser = { installedGatewayV2Operations: [ ] };",
    };
    expect(checkOperations(tree(hidden)).errors).toEqual([
      "OPERATION_LIST_NOT_ADVERTISED PRODUCTION_DEMO_OPERATIONS",
    ]);
  });

  it("[四处一致] reports a list with no gateway at all", () => {
    const files = { ...wired, [gatewayFile]: null, [compositionFile]: null };
    expect(checkOperations(tree(files)).errors).toEqual([
      "OPERATIONS_GATEWAY_MISSING",
      "OPERATION_DECLARED_NOT_INSTALLED demo.read (demo)",
      "OPERATION_DECLARED_NOT_INSTALLED demo.write (demo)",
    ]);
  });

  it("[四处一致] reports a list the browser configuration advertises but the gateway does not install", () => {
    const files = {
      ...wired,
      [compositionFile]:
        "const browser = { installedGatewayV2Operations: [ ...PRODUCTION_DEMO_OPERATIONS, ...PRODUCTION_GHOST_OPERATIONS ] };",
    };
    expect(checkOperations(tree(files)).errors).toEqual([
      "OPERATION_LIST_NOT_IN_GATEWAY PRODUCTION_GHOST_OPERATIONS",
    ]);
  });

  it("[四处一致] reports a missing advertising array, a missing inventory and an unparsable inventory", () => {
    expect(
      checkOperations(tree({ ...wired, [compositionFile]: "const browser = {};" })).errors,
    ).toEqual(["OPERATIONS_ADVERTISING_MISSING"]);
    expect(checkOperations(tree({ ...wired, [inventoryFile]: null })).errors).toEqual([
      "OPERATIONS_INVENTORY_MISSING",
    ]);
    expect(
      checkOperations(tree({ ...wired, [inventoryFile]: "export const nothing = [];" })).errors,
    ).toEqual(["OPERATIONS_INVENTORY_UNPARSED"]);
  });

  it("[四处一致] matches an exact route written with ===", () => {
    const exact = {
      ...wired,
      [gatewayFile]: gateway({
        query: 'query.type === "demo.read"',
        command: 'command.type === "demo.write"',
      }),
    };
    expect(checkOperations(tree(exact)).errors).toEqual([]);
  });

  it("[四处一致] checks an unconditional list for a stolen route and a missing handler", () => {
    const base = {
      ...wired,
      [gatewayFile]: `const reads = { query: (query) => query.type.startsWith("other.") && options.otherControl ? 1 : 2 };
const service = { installedOperations: [ ...PRODUCTION_DEMO_OPERATIONS ] };`,
    };
    expect(checkOperations(tree(base)).errors).toEqual([]);
    const stolen = {
      ...base,
      [gatewayFile]: base[gatewayFile].replace('"other."', '"demo."'),
    };
    expect(checkOperations(tree(stolen)).errors).toEqual([
      "OPERATION_ROUTED_TO_OTHER_HANDLER demo.read 走到 otherControl，应由 PRODUCTION_DEMO_OPERATIONS 的基础处理方接住",
    ]);
    const missing = {
      ...base,
      "apps/agent-service/src/production-demo.ts": demoList.replace(
        'if (m.type === "demo.write") {}',
        "",
      ),
      "apps/agent-service/src/handler.ts": `if (m.type === "demo.read") {}`,
    };
    expect(checkOperations(tree(missing)).errors).toEqual([
      "OPERATION_HANDLER_MISSING demo.write (apps/agent-service/src/production-demo.ts 里没有处理它的代码)",
      "OPERATION_INCOMPLETE demo.write 缺：后端实现",
    ]);
  });

  const inventory = `export function isSurfaceInstalled(surface) { return surface.id === "threads"; }
export const CONTROL_CENTER_SURFACE_INVENTORY = [
  {
    id: "threads",
    queries: ["thread.list"],
    mutations: [],
  },
  {
    id: "demo",
    queries: ["demo.read"],
    mutations: ["demo.write", "demo.later"],
  },
];`;
  const laterContract = contract
    .replace('"demo.snapshot",', '"demo.snapshot",\n  "demo.later",')
    .concat('const d = object({ ...commandEnvelope("demo.later") });\n');
  const later = {
    ...wired,
    "packages/gateway-contracts/src/contracts-v2.ts": laterContract,
    [inventoryFile]: inventory,
    "apps/agent-service/src/later.ts": `if (m.type === "demo.later") {}`,
    "apps/control-center/src/later.ts": `send("demo.later");`,
    "apps/agent-service/test/later.test.ts": `"demo.later";`,
  };

  it("[四处一致] reports an operation the inventory declares but nothing installs", () => {
    expect(checkOperations(tree(later)).errors).toEqual([
      "OPERATION_DECLARED_NOT_INSTALLED demo.later (demo)",
    ]);
  });

  it("[四处一致] accepts a declared but uninstalled operation with a reason in notInstalled", () => {
    const reason = "契约和页面已有，生产还没装配";
    expect(checkOperations(tree(later, {}, { "demo.later": reason })).errors).toEqual([]);
  });

  it("[四处一致] a notInstalled entry does not hide a missing implementation", () => {
    const reason = "契约和页面已有，生产还没装配";
    const files = { ...later, "apps/agent-service/src/later.ts": "const nothing = 1;" };
    expect(checkOperations(tree(files, {}, { "demo.later": reason })).errors).toEqual([
      "OPERATION_INCOMPLETE demo.later 缺：后端实现",
    ]);
  });

  it("[四处一致] asks to remove a notInstalled entry once the operation is installed", () => {
    const reason = "契约和页面已有，生产还没装配";
    expect(checkOperations(tree(wired, {}, { "demo.write": reason })).errors).toEqual([
      "OPERATION_NOT_INSTALLED_BUT_INSTALLED demo.write 已安装，从 ci/operations-pending.json 的 notInstalled 移除",
    ]);
  });

  it("[四处一致] reads an inventory entry written inline and an assignment-style array", () => {
    const inline = `export function isSurfaceInstalled(surface) { return surface.id === "threads"; }
export const CONTROL_CENTER_SURFACE_INVENTORY = [{ id: "demo", queries: ["demo.read"], mutations: ["demo.write", "demo.later"] }];`;
    expect(checkOperations(tree({ ...later, [inventoryFile]: inline })).errors).toEqual([
      "OPERATION_DECLARED_NOT_INSTALLED demo.later (demo)",
    ]);
    const assigned = {
      ...wired,
      [compositionFile]: "installedGatewayV2Operations = [ ...PRODUCTION_DEMO_OPERATIONS ];",
    };
    expect(checkOperations(tree(assigned)).errors).toEqual([]);
  });

  it("[四处一致] does not let the installed array bodies pair with a dangling predicate", () => {
    const dangling = {
      ...wired,
      [gatewayFile]: `const tail = command.type.startsWith("demo.");
const other = { installedOperations: [ ...(options.otherControl ? PRODUCTION_OTHER_OPERATIONS : []) ] };
${gateway()}`,
    };
    expect(checkOperations(tree(dangling)).errors).toEqual([
      "OPERATION_LIST_NOT_ADVERTISED PRODUCTION_OTHER_OPERATIONS",
    ]);
  });

  it("[四处一致] rejects a notInstalled entry nobody declares and one listed in both sections", () => {
    const reason = "契约和页面已有，生产还没装配";
    expect(checkOperations(tree(wired, {}, { "demo.snapshot": reason })).errors).toEqual([
      "OPERATION_NOT_INSTALLED_NOT_DECLARED demo.snapshot 控制中心清单没有声明它",
      "OPERATION_PENDING_NOT_IN_CONTRACT demo.snapshot",
    ]);
    expect(
      checkOperations(tree(later, { "demo.later": reason }, { "demo.later": reason })).errors,
    ).toEqual([
      "OPERATION_LEDGER_BOTH_SECTIONS demo.later",
      "OPERATION_PENDING_BUT_COMPLETE demo.later 已齐全，改登记到 notInstalled（ci/operations-pending.json）",
    ]);
  });

  it("[四处一致] strips the installed arrays by position and reads an assigned installedOperations", () => {
    const text = `const decoy = [ ...(options.demoControl ? PRODUCTION_DEMO_OPERATIONS : []) ];\n${gateway().replace("installedOperations:", "installedOperations =")}`;
    expect(checkOperations(tree({ ...wired, [gatewayFile]: text })).errors).toEqual([]);
  });

  it("passes on the real repository", () => {
    expect(checkOperations().errors).toEqual([]);
  });
});
