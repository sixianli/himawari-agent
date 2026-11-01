import { describe, expect, it } from "vitest";
import { resolveBuildInfo } from "../build-info.mjs";

describe("[UI-S3] build information baked into the browser build", () => {
  it("takes the revision and date from the build environment when given", () => {
    expect(
      resolveBuildInfo({ HIMAWARI_BUILD_REVISION: "abcdef1", HIMAWARI_BUILD_DATE: "2026-11-02" }),
    ).toEqual({ revision: "abcdef1", date: "2026-11-02" });
  });
  it("rejects values that are not a revision and a date instead of showing them", () => {
    expect(
      resolveBuildInfo({
        HIMAWARI_BUILD_REVISION: "not-a-hash",
        HIMAWARI_BUILD_DATE: "2026-11-02",
      }),
    ).toBeNull();
    expect(
      resolveBuildInfo({ HIMAWARI_BUILD_REVISION: "abcdef1", HIMAWARI_BUILD_DATE: "yesterday" }),
    ).toBeNull();
  });
  it("reads the current checkout when the environment says nothing", () => {
    const info = resolveBuildInfo({});
    expect(info?.revision).toMatch(/^[0-9a-f]{7,40}$/);
    expect(info?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
