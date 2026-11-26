import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const HISTORICAL = [
  ".agents/reviews/",
  "docs/",
  "test/qualification/evidence/",
  "scripts/delivery-mode/packet-template/acceptance/cloud/basis-04/",
  "scripts/delivery-mode/packet-template/acceptance/cloud/probe-source/",
];
const VERSION = String.raw`(?<version>\d+\.\d+\.\d+)`;
const PATTERNS = [
  new RegExp(String.raw`\bsrt:${VERSION}`, "g"),
  new RegExp(
    String.raw`\b(?:srt[_-]?[vV]ersion|sandboxRuntimeVersion|SRT_VERSION|SANDBOX_RUNTIME_VERSION)['"]?[?!]?\s*(?::\s*[A-Za-z_][\w<>|. ]*?\s*)?[:=]\s*(?<quote>['"]?)${VERSION}\k<quote>`,
    "g",
  ),
  new RegExp(String.raw`\bsrt['"]?\s*:\s*(?<quote>['"]?)${VERSION}\k<quote>`, "g"),
  new RegExp(String.raw`sandbox-runtime@[\^~]?${VERSION}`, "g"),
  new RegExp(String.raw`sandbox-runtime-${VERSION}\.tgz`, "g"),
  new RegExp(
    String.raw`(?<key>['"])@anthropic-ai/sandbox-runtime\k<key>:\s*(?<quote>['"])[\^~]?${VERSION}\k<quote>`,
    "g",
  ),
  new RegExp(String.raw`\bSRT ${VERSION}`, "g"),
];

export function srtVersionProblems(root) {
  const read = (relative) => readFileSync(path.join(root, relative), "utf8");
  const problems = [];
  const constant = /export const SANDBOX_RUNTIME_VERSION = "(\d+\.\d+\.\d+)" as const;/.exec(
    read("packages/execution-contracts/src/sandbox-runtime-version.ts"),
  )?.[1];
  if (!constant) return ["SRT_VERSION_CONSTANT_MISSING"];
  const dependency = JSON.parse(read("packages/runtime-sandbox/package.json")).dependencies?.[
    "@anthropic-ai/sandbox-runtime"
  ];
  if (dependency !== constant)
    problems.push(
      `SRT_VERSION_DEPENDENCY_MISMATCH packages/runtime-sandbox/package.json ${dependency}`,
    );
  const lockPackages = JSON.parse(read("package-lock.json")).packages;
  const workspaceLocked =
    lockPackages?.["packages/runtime-sandbox"]?.dependencies?.["@anthropic-ai/sandbox-runtime"];
  if (workspaceLocked !== constant)
    problems.push(
      `SRT_VERSION_LOCK_MISMATCH package-lock.json packages/runtime-sandbox ${workspaceLocked}`,
    );
  const locked = lockPackages?.["node_modules/@anthropic-ai/sandbox-runtime"];
  if (
    locked?.version !== constant ||
    locked?.resolved?.endsWith(`/sandbox-runtime-${constant}.tgz`) !== true
  )
    problems.push(`SRT_VERSION_LOCK_MISMATCH package-lock.json ${locked?.version}`);
  const installedRoot = path.join(root, "node_modules/@anthropic-ai/sandbox-runtime");
  const installed = existsSync(path.join(installedRoot, "package.json"))
    ? JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8")).version
    : null;
  if (installed !== constant) problems.push(`SRT_VERSION_INSTALLED_MISMATCH ${installed}`);
  const identity = read("packages/runtime-sandbox/src/srt-runtime-identity.ts");
  for (const arch of ["x64", "arm64"]) {
    const pinned = new RegExp(String.raw`${arch}: "([a-f0-9]{64})"`).exec(identity)?.[1];
    const helper = path.join(installedRoot, "vendor/seccomp", arch, "apply-seccomp");
    const actual = existsSync(helper)
      ? createHash("sha256").update(readFileSync(helper)).digest("hex")
      : null;
    if (!pinned || pinned !== actual)
      problems.push(`SRT_SECCOMP_HELPER_DIGEST_MISMATCH ${arch} ${actual}`);
  }
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => file && file !== "package-lock.json")
    .filter((file) => !HISTORICAL.some((prefix) => file.startsWith(prefix)));
  const stale = new Set();
  for (const file of files) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) continue;
    const text = readFileSync(absolute, "utf8");
    if (text.includes("\0")) continue;
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      for (const pattern of PATTERNS)
        for (const match of line.matchAll(pattern))
          if (match.groups?.version !== constant)
            stale.add(`SRT_VERSION_STALE ${file}:${index + 1} ${match[0]}`);
    });
  }
  return [...problems, ...stale];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(process.argv[2] ?? ".");
  const problems = srtVersionProblems(root);
  for (const problem of problems) console.log(problem);
  console.log(`SRT_VERSION ${problems.length ? "failed" : "passed"}`);
  process.exitCode = problems.length ? 1 : 0;
}
