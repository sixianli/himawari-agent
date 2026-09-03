import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function artifactOutput(env) {
  if (!/^[1-9][0-9]*$/u.test(env.CI_ARTIFACT_ID ?? "")) throw new Error("CI_ARTIFACT_ID_INVALID");
  const name = { "linux-x64": "linux", "macos-arm64": "macos" }[env.CI_MATRIX];
  if (!name) throw new Error("CI_ARTIFACT_PLATFORM_INVALID");
  return `${name}=${env.CI_ARTIFACT_ID}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.env.GITHUB_OUTPUT) throw new Error("CI_GITHUB_OUTPUT_REQUIRED");
    appendFileSync(process.env.GITHUB_OUTPUT, artifactOutput(process.env));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
