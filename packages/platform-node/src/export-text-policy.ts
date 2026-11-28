import {
  containsRestrictedIdentifier,
  EGRESS_RULESET_FIRST_LOOSE_PASSWORDS,
  findSensitiveValues,
  redactForExternalText,
} from "@himawari-agent/sensitive-capture";

export interface DataExportTextPolicy {
  readonly rulesetVersion: number;
  hasSecret(text: string): boolean;
  mask(text: string): string;
}

const EXPORT_RULESET = EGRESS_RULESET_FIRST_LOOSE_PASSWORDS;

export function createDataExportTextPolicy(): DataExportTextPolicy {
  return Object.freeze({
    rulesetVersion: EXPORT_RULESET,
    hasSecret: (text: string): boolean =>
      findSensitiveValues(text, EXPORT_RULESET).length > 0 || containsRestrictedIdentifier(text),
    mask: (text: string): string => redactForExternalText(text, { ruleset: EXPORT_RULESET }).text,
  });
}
