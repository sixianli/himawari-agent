import { execFileSync } from "node:child_process";

export function safe(input: string) {
  const parsed = JSON.parse(input);
  const tls = { rejectUnauthorized: true };
  const output = execFileSync("git", ["show", "--format=%H", "HEAD"]);
  return { parsed, tls, output };
}
