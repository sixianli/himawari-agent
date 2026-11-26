import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  path.resolve(import.meta.dirname, "../../scripts/operations/install-deploy-key.sh"),
  "utf8",
);

describe("install-deploy-key.sh remote arguments", () => {
  it("quotes every argument so the public key reaches the remote shell as one word", () => {
    expect(script).toContain('printf \'%q %q %q\' "$account" "$library" "$public"');
  });

  it("delivers a public key containing a space as a single argument through a remote shell", () => {
    const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample";
    const quoted = spawnSync(
      "bash",
      ["-c", 'printf "%q %q %q" "$1" "$2" "$3"', "_", "acct", "/lib", publicKey],
      {
        encoding: "utf8",
      },
    ).stdout;
    const remote = spawnSync("bash", ["-c", `bash -s -- ${quoted}`], {
      input: 'printf "%s|" "$#" "$3"\n',
      encoding: "utf8",
    });
    expect(remote.stdout).toBe(`3|${publicKey}|`);
  });
});
