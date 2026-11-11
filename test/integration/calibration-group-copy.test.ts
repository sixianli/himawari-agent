import { DECISION_KINDS } from "@himawari-agent/application/decision-ledger";
import { CALIBRATION_GROUPS } from "@himawari-agent/calibration";
import { describe, expect, it } from "vitest";
import { messages as en } from "../../apps/control-center/src/i18n/resources/en.ts";
import { messages as ja } from "../../apps/control-center/src/i18n/resources/ja.ts";
import { messages as zh } from "../../apps/control-center/src/i18n/resources/zh-CN.ts";

const LANGUAGES = [
  ["zh-CN", zh],
  ["en", en],
  ["ja", ja],
] as const;

describe("copy for every calibration group and decision kind", () => {
  it.each(LANGUAGES)(
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

  it.each(LANGUAGES)(
    "[P2-2] %s names every decision kind in the record drawer and the weekly check",
    (_name, messages) => {
      for (const key of ["decision.chain.kind", "weekly.check.rowsMissing"] as const)
        for (const kind of DECISION_KINDS)
          expect(messages[key], `${key} ${kind}`).toContain(` ${kind} {`);
    },
  );
});
