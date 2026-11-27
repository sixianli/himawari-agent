import type { GovernedActionIntent } from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import { BROWSER_SITE_TARGET } from "../../apps/agent-service/src/production-browser-tools.js";
import {
  CALL_MS,
  call,
  computer,
  installBrowserToolHarness,
  pending,
  resource,
  respond,
  Stopped,
  use,
} from "../fixtures/browser-tool-harness.ts";
import { AGENT_ID, OWNER_ID } from "../fixtures/sqlite-capability-invocation-fixture.js";

installBrowserToolHarness();

describe("browser tool in the owner's own computer", () => {
  it(
    "asks the owner before the first visit to a site and opens nothing when the owner says no",
    async () => {
      const before = computer.calls.length;
      await expect(
        use(call("call:denied", { action: "open", url: "https://example.org/" })),
      ).rejects.toBeInstanceOf(Stopped);
      const approval = await pending();
      expect(approval.display).toMatchObject({ displayTitle: "用浏览器访问 example.org" });
      expect(
        (approval.intentSnapshot as GovernedActionIntent).targets.filter(
          ({ type }) => type === BROWSER_SITE_TARGET,
        ),
      ).toEqual([{ type: BROWSER_SITE_TARGET, ref: "example.org" }]);
      await respond(approval, "denied");
      await expect(
        use(call("call:denied", { action: "open", url: "https://example.org/" })),
      ).rejects.toBeInstanceOf(Stopped);
      expect(computer.calls.length).toBe(before);
    },
    CALL_MS,
  );

  it(
    "words the approval in the language the owner picked",
    async () => {
      const preferences = resource.repository.ownerPreferences();
      const current = await preferences.read({ ownerId: OWNER_ID, agentId: AGENT_ID });
      await preferences.write({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        name: current.name,
        locale: "en",
        accent: current.accent,
        theme: current.theme,
        modelRef: current.modelRef,
        thinkingLevel: current.thinkingLevel,
        expectedRevision: current.revision,
        now: new Date().toISOString(),
      });
      try {
        await expect(
          use(call("call:english", { action: "open", url: "https://example.net/" })),
        ).rejects.toBeInstanceOf(Stopped);
        const approval = await pending();
        expect(approval.display).toMatchObject({ displayTitle: "Use the browser on example.net" });
        await respond(approval, "denied");
      } finally {
        const latest = await preferences.read({ ownerId: OWNER_ID, agentId: AGENT_ID });
        await preferences.write({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          name: latest.name,
          locale: null,
          accent: latest.accent,
          theme: latest.theme,
          modelRef: latest.modelRef,
          thinkingLevel: latest.thinkingLevel,
          expectedRevision: latest.revision,
          now: new Date().toISOString(),
        });
      }
    },
    CALL_MS,
  );

  it(
    "hands the screenshot to a model that can see images and only a note to one that cannot",
    async () => {
      const seen = await use(
        call("call:shot-image", { action: "screenshot" }, "model-with-images"),
      );
      expect(seen.images?.[0]?.mimeType).toBe("image/png");
      expect(
        Buffer.from(seen.images?.[0]?.data ?? "", "base64")
          .subarray(1, 4)
          .toString(),
      ).toBe("PNG");
      expect(computer.calls.at(-1)?.allowedDomains).toEqual([]);
      const blind = await use(call("call:shot-text", { action: "screenshot" }));
      expect(blind.images).toBeUndefined();
      expect(blind.value).toMatchObject({ note: expect.stringContaining("read") });
    },
    CALL_MS * 2,
  );

  it("rejects arguments that do not belong to the action without touching the computer", async () => {
    const before = computer.calls.length;
    for (const args of [
      { action: "open", url: "file:///etc/passwd" },
      { action: "open", url: "https://example.com/", hosts: ["not a host"] },
      { action: "click" },
      { action: "read", url: "https://example.com/" },
      { action: "delete" },
    ])
      await expect(use(call(`call:invalid:${JSON.stringify(args)}`, args))).rejects.toMatchObject({
        code: "BROWSER_INPUT_INVALID",
      });
    expect(computer.calls.length).toBe(before);
  });
});
