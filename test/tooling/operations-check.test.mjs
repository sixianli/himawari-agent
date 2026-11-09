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
    };
    expect(checkOperations(tree(files)).errors).toEqual([
      "OPERATION_INSTALLED_NOT_IN_CONTRACT demo.ghost (PRODUCTION_DEMO_OPERATIONS in apps/agent-service/src/production-demo.ts)",
    ]);
  });

  it("does not let the installed list itself stand in for the implementation", () => {
    const files = {
      ...complete,
      "apps/agent-service/src/handler.ts": `if (m.type === "demo.read") {}`,
      "apps/agent-service/src/production-demo.ts": `export const PRODUCTION_DEMO_OPERATIONS = Object.freeze(["demo.write"] as const);`,
    };
    expect(checkOperations(tree(files)).errors).toEqual([
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

  it("passes on the real repository", () => {
    expect(checkOperations().errors).toEqual([]);
  });
});
