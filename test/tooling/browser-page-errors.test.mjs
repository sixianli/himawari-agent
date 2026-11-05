import { expect, it } from "vitest";
import { isWebKitCancelledApiFetch } from "../../scripts/ci/browser-page-errors.mjs";

it.each([
  "/127.0.0.1:36711/api/gateway/v2/queries due to access control checks.",
  "Fetch API cannot load http://127.0.0.1:36711/api/gateway/v2/queries due to access control checks.",
  "Fetch API cannot load http://127.0.0.1:4100/api/gateway/thread/v3/queries?after=7 due to access control checks.",
  "EventSource cannot load http://127.0.0.1:4100/api/gateway/v2/events due to access control checks.",
  "/127.0.0.1:43087/api/payload/v1/text/read due to access control checks.",
])("treats WebKit's uncatchable cancelled API fetch as expected: %s", (message) => {
  expect(isWebKitCancelledApiFetch(message)).toBe(true);
});

it.each([
  "TypeError: Load failed",
  "Fetch API cannot load https://other.invalid/api/data due to access control checks.",
  "Fetch API cannot load http://127.0.0.1:36711/assets/index.js due to access control checks.",
  "CONTROL_CENTER_RESPONSE_INVALID /api/gateway/v2/queries",
  "Fetch API cannot load http://127.0.0.1:36711/api/gateway/v2/queries due to access control checks. TypeError",
])("keeps every other page error: %s", (message) => {
  expect(isWebKitCancelledApiFetch(message)).toBe(false);
});
