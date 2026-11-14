import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const relatedEligibleProjects = ["integration", "e2e", "pi-compat", "tooling"];

const ignorable = (file) => file.startsWith(".agents/") || file.endsWith(".md");
const sourceFile = (file) =>
  /^(?:apps|packages|test)\/.+\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(file) &&
  !/(?:^|\/)[^/]*\.config\.[^/]+$/u.test(file) &&
  !/(?:^|\/)vitest\.[^/]+$/u.test(file);

export function classifyChanges(files) {
  const fullFiles = files.filter((file) => !ignorable(file) && !sourceFile(file));
  return { full: fullFiles.length > 0, fullFiles };
}

export function changedFiles(root, base, tested) {
  const result = spawnSync("git", ["diff", "--name-only", "-z", base, tested], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("CI_TEST_SCOPE_DIFF_FAILED");
  return result.stdout.split("\0").filter(Boolean);
}

export function listRelatedFiles({ root, project, baseSha, run = spawnSync }) {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-related-"));
  try {
    const output = path.join(directory, "list.json");
    const result = run(
      process.execPath,
      [
        path.join(root, "node_modules/vitest/vitest.mjs"),
        "list",
        "--config",
        "vitest.workspace.ts",
        "--project",
        project,
        "--filesOnly",
        `--json=${output}`,
        "--changed",
        baseSha,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.status !== 0) return null;
    const listed = JSON.parse(readFileSync(output, "utf8"));
    if (!Array.isArray(listed)) return null;
    return [
      ...new Set(listed.map((entry) => path.relative(root, entry.file).split(path.sep).join("/"))),
    ].sort();
  } catch {
    return null;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function planTestScope({
  root,
  context,
  projects,
  diff = changedFiles,
  list = listRelatedFiles,
}) {
  const related = new Map();
  if (context.event !== "pull_request") return { related, reason: "full-event" };
  const changes = classifyChanges(diff(root, context.baseSha, context.testedSha));
  if (changes.full)
    return { related, reason: `full-files ${changes.fullFiles.slice(0, 5).join(" ")}` };
  const fallback = [];
  for (const project of projects.filter((id) => relatedEligibleProjects.includes(id))) {
    const files = list({ root, project, baseSha: context.baseSha });
    if (files === null) fallback.push(project);
    else related.set(project, files);
  }
  return {
    related,
    reason: fallback.length ? `related full-fallback ${fallback.join(",")}` : "related",
  };
}

export const zeroCounts = () => ({ files: 0, executed: 0, passed: 0, failed: 0, skipped: 0 });
