import {
  GATEWAY_MESSAGE_TYPES,
  GATEWAY_V2_MESSAGE_TYPES,
  THREAD_GATEWAY_MESSAGE_TYPES,
} from "@himawari-agent/gateway-contracts";
import { describe, expect, it } from "vitest";
import {
  CONTROL_CENTER_ACCEPTANCE_IDS,
  CONTROL_CENTER_INTEGRATION_READY_SURFACE_IDS,
  CONTROL_CENTER_REQUIRED_UI_STATES,
  CONTROL_CENTER_SURFACE_INVENTORY,
} from "../src/app/control-center-inventory.js";

const expectedSurfaceIds = [
  "threads",
  "approvals",
  "tasks",
  "inbox-digest",
  "memory",
  "capabilities-adapters",
  "authorizations-grants",
  "trace",
  "settings",
  "sessions-devices",
  "health-deployment",
];

describe("control center information architecture inventory", () => {
  it("covers every required surface, acceptance and UI state exactly", () => {
    expect(CONTROL_CENTER_SURFACE_INVENTORY.map(({ id }) => id)).toEqual(expectedSurfaceIds);
    expect(new Set(CONTROL_CENTER_SURFACE_INVENTORY.map(({ route }) => route)).size).toBe(
      expectedSurfaceIds.length,
    );
    expect(
      [
        ...new Set(CONTROL_CENTER_SURFACE_INVENTORY.flatMap(({ acceptanceIds }) => acceptanceIds)),
      ].sort(),
    ).toEqual([...CONTROL_CENTER_ACCEPTANCE_IDS].sort());
    for (const surface of CONTROL_CENTER_SURFACE_INVENTORY) {
      expect(surface.requiredUiStates).toEqual(CONTROL_CENTER_REQUIRED_UI_STATES);
      expect(surface.stableObjects.length).toBeGreaterThan(0);
      expect(surface.sourceSpec).toMatch(
        /^docs\/(?:execution\/specs|archive\/specs)\/.+-design\.md$/,
      );
    }
  });

  it("references only implemented Gateway message types", () => {
    const implementedTypes = new Set([
      ...GATEWAY_MESSAGE_TYPES,
      ...GATEWAY_V2_MESSAGE_TYPES,
      ...THREAD_GATEWAY_MESSAGE_TYPES,
    ]);
    for (const surface of CONTROL_CENTER_SURFACE_INVENTORY) {
      for (const type of [...surface.queries, ...surface.mutations]) {
        expect(implementedTypes.has(type as never), `${surface.id}:${type}`).toBe(true);
      }
    }
  });

  it("allows integration only for a frozen contract and blocks incomplete semantics", () => {
    expect(CONTROL_CENTER_INTEGRATION_READY_SURFACE_IDS).toEqual([
      "threads",
      "approvals",
      "tasks",
      "inbox-digest",
      "memory",
      "capabilities-adapters",
      "authorizations-grants",
      "trace",
      "settings",
      "sessions-devices",
      "health-deployment",
    ]);
    for (const surface of CONTROL_CENTER_SURFACE_INVENTORY) {
      if (surface.integrationPolicy === "allowed") {
        expect(surface.contractStatus).toBe("frozen");
        expect(surface.queries.length).toBeGreaterThan(0);
        expect(surface.blockers).toEqual([]);
      } else {
        expect(surface.contractStatus).not.toBe("frozen");
        expect(surface.blockers.length).toBeGreaterThan(0);
      }
    }
  });
});
