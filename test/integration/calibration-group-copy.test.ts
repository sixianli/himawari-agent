import { CALIBRATION_GROUPS } from "@himawari-agent/calibration";
import { describe, expect, it } from "vitest";
import { messages as en } from "../../apps/control-center/src/i18n/resources/en.ts";
import { messages as ja } from "../../apps/control-center/src/i18n/resources/ja.ts";
import { messages as zh } from "../../apps/control-center/src/i18n/resources/zh-CN.ts";

describe("weekly report copy for every calibration group", () => {
  it.each([
    ["zh-CN", zh],
    ["en", en],
    ["ja", ja],
  ] as const)(
    "[P2-2] %s names every group instead of showing it as another one",
    (_name, messages) => {
      const select = messages["weekly.group"];
      for (const group of CALIBRATION_GROUPS) {
        if (group === "external_read") continue;
        expect(select, group).toContain(` ${group} {`);
      }
      expect(messages["weekly.groupInfo"]).toContain(" rule_review {");
    },
  );
});
