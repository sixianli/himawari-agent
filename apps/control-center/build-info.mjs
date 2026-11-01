import { execFileSync } from "node:child_process";

const REVISION_PATTERN = /^[0-9a-f]{7,40}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function fromGit() {
  try {
    return execFileSync("git", ["log", "-1", "--format=%h%n%cs"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n");
  } catch {
    return [];
  }
}

export function resolveBuildInfo(environment) {
  const [gitRevision, gitDate] = fromGit();
  const revision = environment.HIMAWARI_BUILD_REVISION ?? gitRevision ?? "";
  const date = environment.HIMAWARI_BUILD_DATE ?? gitDate ?? "";
  return REVISION_PATTERN.test(revision) && DATE_PATTERN.test(date) ? { revision, date } : null;
}
