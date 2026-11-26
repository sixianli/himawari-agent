import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DOCUMENTATION = [/^docs\//u, /\.md$/u, /^\.agents\/evidence\//u];

export function needsIphoneEndToEnd(files) {
  if (files === null) return true;
  return files.some((file) => !DOCUMENTATION.some((pattern) => pattern.test(file)));
}

function changedFiles(base, head) {
  if (!base || /^0+$/u.test(base)) return null;
  try {
    return execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [base, head = "HEAD"] = process.argv.slice(2);
  const files = changedFiles(base, head);
  const run = needsIphoneEndToEnd(files);
  process.stderr.write(
    `IOS_E2E_SCOPE run=${run} files=${files === null ? "unknown" : files.length}\n`,
  );
  process.stdout.write(`run=${run}\n`);
}
