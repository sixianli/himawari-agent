import { describe, expect, it } from "vitest";
import { confirmedFirstByRecency } from "../src/production-memory-capture.ts";

describe("[PA-2] extraction offers confirmed memories before tentative ones", () => {
  const record = (id: string, updatedAt: string, tentative?: boolean) => ({
    id,
    updatedAt,
    ...(tentative === undefined ? {} : { attributes: { tentative } }),
  });

  it("keeps recency inside each group and never lets newer tentative memories push confirmed ones out", () => {
    const ordered = confirmedFirstByRecency([
      record("tentative-new", "2026-11-08T03:00:00.000Z", true),
      record("confirmed-old", "2026-11-01T00:00:00.000Z", false),
      record("tentative-newer", "2026-11-08T04:00:00.000Z", true),
      record("confirmed-new", "2026-11-07T00:00:00.000Z"),
    ]);
    expect(ordered.map(({ id }) => id)).toEqual([
      "confirmed-new",
      "confirmed-old",
      "tentative-newer",
      "tentative-new",
    ]);
    expect(ordered.slice(0, 2).map(({ id }) => id)).not.toContain("tentative-new");
  });
});
