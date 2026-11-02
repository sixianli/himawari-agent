import { describe, expect, it } from "vitest";
import {
  failureReason,
  SERVICE_RUNTIME_ERROR_CODES,
  stableErrorCode,
} from "../src/service-runtime.js";

describe("[I-75] a startup failure says why", () => {
  it("carries the error name and message when the code is only the generic startup failure", () => {
    const error = new TypeError("descriptors[1].baseUrl must be a loopback HTTP URL");
    expect(stableErrorCode(error)).toBe(SERVICE_RUNTIME_ERROR_CODES.STARTUP_FAILED);
    expect(failureReason(error)).toBe(
      "TypeError: descriptors[1].baseUrl must be a loopback HTTP URL",
    );
  });

  it("adds nothing when the error already has a specific code", () => {
    expect(failureReason(new Error("CONFIGURATION_INVALID_VALUE"))).toBeUndefined();
  });

  it("is cut to 300 characters", () => {
    expect(failureReason(new Error("x".repeat(1000)))?.length).toBe(300);
  });

  it("names only the type when the thrown value is not an error", () => {
    expect(failureReason("secret text")).toBe("string");
  });
});
