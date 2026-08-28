import { describe, expect, it } from "vitest";
import { controlCenterHref, parseControlCenterUrl, routeForSurface } from "../src/app/router.js";

describe("native control-center router", () => {
  it("round-trips all recoverable list, object and mobile-view state", () => {
    const state = {
      afterCursor: "cursor-42",
      objectId: "thread:primary",
      status: "archived",
      surfaceId: "threads" as const,
      view: "details" as const,
    };
    const href = controlCenterHref(state);
    expect(href).toBe("/threads/thread%3Aprimary?cursor=cursor-42&status=archived&view=details");
    expect(parseControlCenterUrl(href)).toEqual({ kind: "matched", state });
  });

  it("maps root to Threads and rejects malformed or unknown deep links", () => {
    expect(parseControlCenterUrl("/")).toEqual({
      kind: "matched",
      state: routeForSurface("threads"),
    });
    expect(parseControlCenterUrl("/threads/raw/content/path")).toEqual({
      kind: "not_found",
      pathname: "/threads/raw/content/path",
    });
    expect(parseControlCenterUrl("/unknown")).toEqual({
      kind: "not_found",
      pathname: "/unknown",
    });
  });

  it("drops malformed query state instead of propagating it to Gateway queries", () => {
    expect(
      parseControlCenterUrl("/tasks?cursor=contains%20space&status=UPPER&selected=%2Fetc%2Fpasswd"),
    ).toEqual({
      kind: "matched",
      state: routeForSurface("tasks"),
    });
  });
});
