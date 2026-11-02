import { expect, it } from "vitest";
import { servedModelFromHeaders } from "../src/pi-runtime-adapter.js";

it("reads the model that Magpie actually used from the response header", () => {
  expect(servedModelFromHeaders({ "X-Magpie-Model": "opencode-go/glm-5.3-flash" })).toBe(
    "opencode-go/glm-5.3-flash",
  );
});

it("ignores a missing or malformed header", () => {
  expect(servedModelFromHeaders({})).toBeUndefined();
  expect(servedModelFromHeaders({ "x-magpie-model": "no slash" })).toBeUndefined();
  expect(servedModelFromHeaders({ "x-magpie-model": "a/<script>" })).toBeUndefined();
  expect(servedModelFromHeaders({ "x-magpie-provider": "opencode-go" })).toBeUndefined();
});
