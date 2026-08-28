import type { GatewayAuthenticationContext } from "@himawari-agent/application";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserThreadSearchPreparer,
  ScopedThreadSearchTokenizer,
} from "../src/browser-thread-search.js";

const authentication: GatewayAuthenticationContext = {
  subjectId: "owner-01",
  ownerId: "owner-01",
  deviceId: "device-01",
  authenticatedAt: "2026-08-28T00:00:00.000Z",
  authenticationRef: "session-01",
};

function tokenizer() {
  return new ScopedThreadSearchTokenizer({
    keys: {
      async resolve() {
        return new TextEncoder().encode("0123456789abcdef0123456789abcdef");
      },
    },
    projectionVersion: "thread-search-v1",
  });
}

describe("browser Thread search boundary", () => {
  it("normalizes deterministic tokens while cryptographically separating Agent scopes", async () => {
    const service = tokenizer();
    const first = await service.tokenize({
      ownerId: "owner-01",
      agentId: "agent-01",
      text: "Ｈｉｍａｗａｒｉ  对话",
    });
    const normalized = await service.tokenize({
      ownerId: "owner-01",
      agentId: "agent-01",
      text: "himawari 对话",
    });
    const otherAgent = await service.tokenize({
      ownerId: "owner-01",
      agentId: "agent-02",
      text: "himawari 对话",
    });

    expect(first).toEqual(normalized);
    expect(otherAgent).not.toEqual(first);
    expect(first.length).toBeGreaterThan(1);
    expect(JSON.stringify(first)).not.toContain("himawari");
    expect(JSON.stringify(first)).not.toContain("对话");
  });

  it("protects the query body and returns only opaque search references to the browser", async () => {
    const protect = vi.fn(async () => ({ payloadRef: "payload:search-query-01" }));
    const service = new BrowserThreadSearchPreparer({
      tokenizer: tokenizer(),
      payloadAdmission: { protect },
    });
    const result = await service.prepare({
      authentication,
      agentId: "agent-01",
      query: "  私人 Thread 查询  ",
    });

    expect(result).toMatchObject({
      queryRef: "payload:search-query-01",
      projectionVersion: "thread-search-v1",
    });
    expect(result.tokenRefs.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("私人");
    expect(protect).toHaveBeenCalledWith(
      expect.objectContaining({
        authentication,
        content: "私人 Thread 查询",
        dataClassification: "private",
        contentType: "text/plain",
        idempotencyKey: expect.stringMatching(/^thread-search-query:[a-f0-9]{64}$/),
      }),
    );
  });

  it("rejects empty, oversized, and weak-key queries", async () => {
    await expect(
      tokenizer().tokenize({ ownerId: "owner-01", agentId: "agent-01", text: "  " }),
    ).rejects.toThrow("THREAD_SEARCH_QUERY_INVALID");
    await expect(
      tokenizer().tokenize({ ownerId: "owner-01", agentId: "agent-01", text: "x".repeat(2_049) }),
    ).rejects.toThrow("THREAD_SEARCH_QUERY_INVALID");
    const weak = new ScopedThreadSearchTokenizer({
      keys: {
        async resolve() {
          return new Uint8Array(16);
        },
      },
      projectionVersion: "thread-search-v1",
    });
    await expect(
      weak.tokenize({ ownerId: "owner-01", agentId: "agent-01", text: "query" }),
    ).rejects.toThrow("THREAD_SEARCH_KEY_INVALID");
  });
});
