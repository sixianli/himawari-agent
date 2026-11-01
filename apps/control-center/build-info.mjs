import { execFileSync } from "node:child_process";

const REVISION_PATTERN = /^[0-9a-f]{7,40}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function fromGit(cwd) {
  try {
    const [revision, date] = execFileSync("git", ["log", "-1", "--format=%h%n%cs"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n");
    return { revision, date };
  } catch {
    return {};
  }
}

function valid({ revision, date }) {
  return REVISION_PATTERN.test(revision ?? "") && DATE_PATTERN.test(date ?? "");
}

export function resolveBuildInfo(environment, cwd = process.cwd()) {
  const given = {
    revision: environment.HIMAWARI_BUILD_REVISION,
    date: environment.HIMAWARI_BUILD_DATE,
  };
  if (valid(given)) return given;
  const git = fromGit(cwd);
  return valid(git) ? git : null;
}
