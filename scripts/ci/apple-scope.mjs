import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const APPLE_CLIENT = [
  /^clients\/apple\//u,
  /^\.github\/workflows\/apple\.yml$/u,
  /^scripts\/ci\/apple-scope\.mjs$/u,
];

export function touchesAppleClient(files) {
  if (files === null) return true;
  return files.some((file) => APPLE_CLIENT.some((pattern) => pattern.test(file)));
}

const DOCUMENTATION = [/^docs\//u, /\.md$/u, /^\.agents\/evidence\//u];

export function needsIphoneEndToEnd(files) {
  if (files === null) return true;
  return files.some((file) => !DOCUMENTATION.some((pattern) => pattern.test(file)));
}

export function changedFiles(base, head, git = execFileSync) {
  if (!base || /^0+$/u.test(base)) return null;
  try {
    git("git", ["fetch", "--no-tags", "--depth=1", "origin", base], { stdio: "ignore" });
    return String(git("git", ["diff", "--name-only", base, head], { encoding: "utf8" }))
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [base, head = "HEAD"] = process.argv.slice(2);
  const files = changedFiles(base, head);
  const client = touchesAppleClient(files);
  const e2e = needsIphoneEndToEnd(files);
  process.stderr.write(
    `APPLE_SCOPE client=${client} e2e=${e2e} files=${files === null ? "unknown" : files.length}\n`,
  );
  process.stdout.write(`client=${client}\ne2e=${e2e}\n`);
}
