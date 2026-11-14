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
const RELEASE_FROZEN = new Map([
  [
    "scripts/operations/hermes-e2e-fixes-start.mjs",
    "18a8d1732b2cdd834f84ff9f8ffe65b85b8f42d79a3811c5738c15a05ba0130e",
  ],
  [
    "scripts/operations/hermes-harness-start.mjs",
    "a56fe8ebf309874f839811b933161ef5495dc15552d8df586ef45878df7df46a",
  ],
  [
    "scripts/operations/hermes-loop-finalization-start.mjs",
    "03c18c0cd4f6ae519a1288037883e53515c8fa89027070b52f5386a477eee1bf",
  ],
  [
    "scripts/operations/hermes-loop-identity-start.mjs",
    "4e058cb50e18be3a55508b40615b8b9c1b7b86aa3d1255b9983dcc651c9b41f0",
  ],
  [
    "scripts/operations/hermes-native-history-start.mjs",
    "83e47097278c592e837585c3283371fb617a362e949a6172421a79d37f91aa41",
  ],
  [
    "scripts/operations/hermes-protected-start.mjs",
    "03cf3ea57209293a3045d8d553d34431a9d046937ec7de9544e74e4b5e4eec88",
  ],
  [
    "scripts/operations/hermes-search-time-start.mjs",
    "32abd1350081c14e6a9937dc293aa9a0359c81646743f534d8b2e3f59581c817",
  ],
  [
    "scripts/operations/hermes-source-links-start.mjs",
    "bb2df0c1ec1b2d990eb3db00b74440c24e1982eb7e477a5a674dfaad309ee467",
  ],
  [
    "scripts/operations/hermes-three-fixes-start.mjs",
    "363fcfdc19699b2c51b2b08986bd8ba1313c813a9310df69506d55e5bd7d2808",
  ],
  [
    "scripts/operations/hermes-ui-session-start.mjs",
    "417c60f4f2a95710c645e5b0db07ce05b1dd7b6b1e2bcafcbf7d87fc29d990a7",
  ],
]);
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
    .filter((file) => !HISTORICAL.some((prefix) => file.startsWith(prefix)))
    .filter((file) => !RELEASE_FROZEN.has(file));
  for (const [file, pinned] of RELEASE_FROZEN) {
    const absolute = path.join(root, file);
    if (
      existsSync(absolute) &&
      createHash("sha256").update(readFileSync(absolute)).digest("hex") !== pinned
    )
      problems.push(`SRT_FROZEN_RELEASE_CHANGED ${file}`);
  }
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
