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

function tree(files, ledger = {}) {
  const root = mkdtempSync(join(tmpdir(), "operations-check-"));
  roots.push(root);
  const all = {
    "packages/gateway-contracts/src/contracts-v2.ts": contract,
    "ci/operations-pending.json": JSON.stringify({ operations: ledger }),
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
const wired = {
  ...complete,
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
      "OPERATION_PENDING_BUT_COMPLETE demo.write 已齐全，从 ci/operations-pending.json 移除",
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
    };
    expect(checkOperations(tree(files)).errors).toContain(
      "OPERATION_INSTALLED_NOT_IN_CONTRACT demo.ghost (PRODUCTION_DEMO_OPERATIONS in apps/agent-service/src/production-demo.ts)",
    );
  });

  it("does not let the installed list itself stand in for the implementation", () => {
    const files = {
      ...complete,
      "apps/agent-service/src/handler.ts": `if (m.type === "demo.read") {}`,
      "apps/agent-service/src/production-demo.ts": `export const PRODUCTION_DEMO_OPERATIONS = Object.freeze(["demo.write"] as const);`,
      [gatewayFile]: gateway(),
      [compositionFile]: composition,
    };
    expect(checkOperations(tree(files)).errors).toContain(
      "OPERATION_INCOMPLETE demo.write 缺：后端实现",
    );
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
    expect(checkOperations(tree(files)).errors).toEqual(["OPERATIONS_GATEWAY_MISSING"]);
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
  const inventoryFile = "apps/control-center/src/app/control-center-inventory.ts";
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

  it("[四处一致] accepts a declared but uninstalled operation with a pending reason", () => {
    const reason = "契约和页面已有，生产还没装配";
    expect(checkOperations(tree(later, { "demo.later": reason })).errors).toEqual([]);
  });

  it("passes on the real repository", () => {
    expect(checkOperations().errors).toEqual([]);
  });
});
