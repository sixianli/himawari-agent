import { readOnlyRow } from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_TOOL_ACTION_ROWS,
  productionToolActionRegistry,
} from "../src/production-tool-actions.ts";

describe("read-only tool offer", () => {
  it("offers a read-only run only tools that read and change nothing", () => {
    const registry = productionToolActionRegistry();
    const descriptors = PRODUCTION_TOOL_ACTION_ROWS.filter((row) => !row.toolIsPrefix).map(
      (row) => ({
        name: row.tool,
        capabilityRef: row.capabilityRef ?? row.tool,
        capabilityHandleRef: null,
        description: "x",
        parameters: {},
      }),
    );
    const all = registry.offer(descriptors).map((item) => item.name);
    const readOnly = registry.offer(descriptors, { readOnly: true }).map((item) => item.name);
    expect(readOnly.length).toBeGreaterThan(0);
    expect(readOnly.length).toBeLessThan(all.length);
    for (const name of readOnly) {
      const row = registry.forTool(name);
      expect(row && readOnlyRow(row)).toBe(true);
      expect(row?.actionKind).toBe("READ");
      expect(row?.sideEffect).toBe("none");
    }
    for (const name of all.filter((item) => !readOnly.includes(item)))
      expect(readOnlyRow(registry.forTool(name) as never)).toBe(false);
    expect([...readOnly].sort()).toEqual([
      "conversation_open",
      "conversation_search",
      "mail_read",
      "memory_open",
      "perception_read",
      "recall",
      "reminder_list",
      "rule_list",
      "task_get",
      "task_list",
      "tool_result_recall",
      "vault_list",
      "view_subthread",
      "web_fetch",
      "web_search",
    ]);
    for (const name of ["reminder_set", "rule_set", "bash", "write", "device_action"])
      expect(readOnly).not.toContain(name);
  });
});
