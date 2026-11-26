import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  path.resolve(import.meta.dirname, "../../scripts/install/prepare-host-tools.sh"),
  "utf8",
);

describe("prepare-host-tools.sh builder layout", () => {
  it("creates the builder root itself owned by the build account before its subdirectories", () => {
    const own = script.indexOf(
      'install -d -m 0755 -o "$build_user" -g "$build_user" "$builder_root"\n',
    );
    const children = script.indexOf('"$builder_root/$directory"');
    expect(own).toBeGreaterThan(-1);
    expect(own).toBeLessThan(children);
  });
});
