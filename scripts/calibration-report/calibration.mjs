import { execFileSync } from "node:child_process";
import process from "node:process";
import { readCalibrationRows } from "@himawari-agent/calibration";
import { readPrereviewWeek } from "@himawari-agent/calibration/prereview";

export * from "@himawari-agent/calibration";
export * from "@himawari-agent/calibration/prereview";

export function readWindow(database, scope) {
  return database.transaction(() => ({
    ...readCalibrationRows(database, scope),
    prereviews: readPrereviewWeek(database, scope),
  }))();
}

export function findScopes(database) {
  return database
    .prepare("SELECT owner_id AS ownerId, id AS agentId FROM agents ORDER BY owner_id, id")
    .all();
}

export function currentCommit(cwd = process.cwd()) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}
