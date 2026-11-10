import {
  containsRestrictedIdentifier,
  EGRESS_RULESET_CURRENT,
  findSensitiveValues,
  redactForExternalText,
} from "@himawari-agent/sensitive-capture";

export interface DataExportTextPolicy {
  readonly rulesetVersion: number;
  hasSecret(text: string): boolean;
  mask(text: string): string;
}

export function createDataExportTextPolicy(): DataExportTextPolicy {
  return Object.freeze({
    rulesetVersion: EGRESS_RULESET_CURRENT,
    hasSecret: (text: string): boolean =>
      findSensitiveValues(text).length > 0 || containsRestrictedIdentifier(text),
    mask: (text: string): string => redactForExternalText(text).text,
  });
}
