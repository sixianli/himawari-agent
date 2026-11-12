export * from "@himawari-agent/calibration";
export * from "@himawari-agent/calibration/prereview";
import type { CalibrationDatabase, CalibrationRows } from "@himawari-agent/calibration";
import type { PrereviewWeekRow } from "@himawari-agent/calibration/prereview";
export function readWindow(
  database: CalibrationDatabase & { transaction<T>(body: () => T): () => T },
  scope: { ownerId: string; agentId: string; start: string; end: string },
): CalibrationRows & { readonly prereviews: readonly PrereviewWeekRow[] };
export function findScopes(database: CalibrationDatabase): { ownerId: string; agentId: string }[];
export function currentCommit(cwd?: string): string;
