import { afterEach, describe, expect, it } from "vitest";
import { harness, removeDeviceHarnessDirectories } from "../fixtures/device-api-harness.ts";
import { atOffset, perceptionScope, recordId } from "../fixtures/perception-test-client.ts";

afterEach(removeDeviceHarnessDirectories);

function proposal(h: Awaited<ReturnType<typeof harness>>, suffix: string, dedupeKey: string) {
  return {
    scope: perceptionScope,
    id: `suggestion:${suffix.padEnd(16, "0")}`,
    action: "create_reminder" as const,
    parameters: { title: "给妈妈回电话" },
    recordIds: [recordId()],
    dedupeKey,
    expiresAt: atOffset(h, 3600),
    decisionId: null,
  };
}

describe("perception suggestions", () => {
  it("keeps one suggestion per dedupe key and lists only open ones", async () => {
    const h = await harness();
    const first = await h.perception.proposeSuggestion(proposal(h, "first", "call-mom"));
    expect(first.created).toBe(true);
    const repeat = await h.perception.proposeSuggestion(proposal(h, "second", "call-mom"));
    expect(repeat.created).toBe(false);
    expect(repeat.suggestion.id).toBe(first.suggestion.id);
    expect((await h.perception.suggestions(perceptionScope)).map(({ id }) => id)).toEqual([
      first.suggestion.id,
    ]);
  });

  it("dismisses once, stays dismissed and cannot be accepted afterwards", async () => {
    const h = await harness();
    const { suggestion } = await h.perception.proposeSuggestion(proposal(h, "first", "call-mom"));
    const dismissed = await h.perception.dismissSuggestion(perceptionScope, suggestion.id);
    expect(dismissed.status).toBe("dismissed");
    expect((await h.perception.dismissSuggestion(perceptionScope, suggestion.id)).status).toBe(
      "dismissed",
    );
    expect(await h.perception.suggestions(perceptionScope)).toEqual([]);
    await expect(
      h.repository.perception().transitionSuggestion({
        ...perceptionScope,
        suggestionId: suggestion.id,
        to: "accepted",
        allowedFrom: ["open"],
        now: h.clock.now(),
      }),
    ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    await expect(
      h.perception.dismissSuggestion(perceptionScope, "suggestion:missing0000000000"),
    ).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });
  });

  it("expires a suggestion past its time and leaves a fresh one open", async () => {
    const h = await harness();
    const old = await h.perception.proposeSuggestion(proposal(h, "old", "old-key"));
    h.clock.advance(3_601_000);
    const fresh = await h.perception.proposeSuggestion(proposal(h, "fresh", "fresh-key"));
    expect((await h.perception.suggestions(perceptionScope)).map(({ id }) => id)).toEqual([
      fresh.suggestion.id,
    ]);
    const all = await h.repository.perception().listSuggestions({
      ...perceptionScope,
      status: "expired",
    });
    expect(all.map(({ id }) => id)).toEqual([old.suggestion.id]);
  });
});
