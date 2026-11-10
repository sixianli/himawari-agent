import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateInstallScriptReviews } from "../../scripts/ci/check-policy.mjs";

const read = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));

const packageLock = {
  packages: {
    "": {},
    "node_modules/native": { version: "2.0.0", hasInstallScript: true },
    "node_modules/plain": { version: "1.0.0" },
  },
};
const review = (overrides = {}) => ({
  nativeDependencies: [
    { path: "node_modules/native", name: "native", version: "2.0.0", ...overrides },
  ],
});

describe("[I-91] install-script reviews match package-lock.json", () => {
  it("accepts the repository's real lock files", () => {
    expect(
      validateInstallScriptReviews(read("ci/toolchain-lock.json"), read("package-lock.json")),
    ).toBe(true);
  });

  it("accepts matching fixtures", () => {
    expect(validateInstallScriptReviews(review(), packageLock)).toBe(true);
  });

  it("rejects a review recorded for an older version", () => {
    expect(() => validateInstallScriptReviews(review({ version: "1.52.0" }), packageLock)).toThrow(
      /version differs/,
    );
  });

  it("rejects a review whose package name differs from its path", () => {
    expect(() => validateInstallScriptReviews(review({ name: "other" }), packageLock)).toThrow(
      /name differs/,
    );
  });

  it("rejects a stale review whose package left the lock file", () => {
    expect(() =>
      validateInstallScriptReviews(review({ path: "node_modules/gone" }), packageLock),
    ).toThrow(/missing from package-lock/);
  });

  it("rejects a review for a package without an install script", () => {
    expect(() =>
      validateInstallScriptReviews(
        review({ path: "node_modules/plain", name: "plain", version: "1.0.0" }),
        {
          packages: packageLock.packages,
        },
      ),
    ).toThrow(/without install script/);
  });

  it("rejects a locked install script that has no review", () => {
    expect(() => validateInstallScriptReviews({ nativeDependencies: [] }, packageLock)).toThrow(
      /not reviewed/,
    );
  });
});
