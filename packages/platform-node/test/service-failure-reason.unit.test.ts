import { describe, expect, it } from "vitest";
import {
  failureReason,
  portErrorSite,
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

describe("[I-94] a port conflict says which check refused", () => {
  it("returns the refusing check's message for a PORT_ error", () => {
    const error = Object.assign(new Error("Budget account classification is immutable"), {
      code: "PORT_CONFLICT",
    });
    expect(portErrorSite(error)).toBe("Budget account classification is immutable");
  });

  it("is cut to 200 characters", () => {
    const error = Object.assign(new Error("x".repeat(500)), { code: "PORT_CONFLICT" });
    expect(portErrorSite(error)?.length).toBe(200);
  });

  it("adds nothing for errors that are not port errors", () => {
    expect(portErrorSite(new Error("MEMORY_CAPTURE_FAILED"))).toBeUndefined();
    expect(portErrorSite(Object.assign(new Error("secret"), { code: "AI_GATEWAY_X" }))).toBe(
      undefined,
    );
    expect(portErrorSite("PORT_CONFLICT")).toBeUndefined();
  });
});
