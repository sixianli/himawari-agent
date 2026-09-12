import { RuntimeHistoryService } from "@himawari-agent/application";
import { createAgentId, createOwnerId, createRunId } from "@himawari-agent/domain";
import {
  EnvelopePayloadProtector,
  InMemoryDevelopmentSecretSource,
} from "@himawari-agent/platform-node";
import { createReferenceAdapterSet, ManualClock } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const ownerId = createOwnerId("history-owner"),
  agentId = createAgentId("history-agent");
function fixture() {
  const clock = new ManualClock("2026-09-11T00:00:00.000Z");
  const adapters = createReferenceAdapterSet({ clock, scope: { ownerId, agentId } });
  const protector = new EnvelopePayloadProtector({
    keys: new InMemoryDevelopmentSecretSource({ "history-key@v1": new Uint8Array(32).fill(9) }),
    activeKey: { keyRef: "history-key", kekVersion: "v1", dekVersion: "v1" },
  });
  const dependencies = {
    ownerId,
    agentId,
    clock,
    ids: adapters.ids,
    artifacts: adapters.runPayloadArtifacts,
    payloads: adapters.payload,
    protector,
  };
  return { adapters, dependencies, service: new RuntimeHistoryService(dependencies) };
}
const messages = [
  { role: "user", content: "创建文件", timestamp: 1 },
  {
    role: "assistant",
    provider: "original-provider",
    model: "original-model",
    api: "openai-completions",
    stopReason: "toolUse",
    content: [
      { type: "toolCall", id: "call-1", name: "write", arguments: { path: "acceptance.txt" } },
    ],
    timestamp: 2,
  },
  {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "write",
    isError: true,
    content: [{ type: "text", text: "approval_denied" }],
    timestamp: 3,
  },
];
describe("protected runtime history", () => {
  it("restores native tool history and model identity after restarting the service", async () => {
    const f = fixture();
    const reference = await f.service.save({
      runId: createRunId("history-run"),
      dataClassification: "private",
      messages,
    });
    const restarted = new RuntimeHistoryService(f.dependencies);
    expect((await restarted.load(reference, "private")).messages).toEqual(messages);
  });
  it("keeps a pinned snapshot immutable when a later message arrives", async () => {
    const f = fixture();
    const first = await f.service.save({
      runId: createRunId("history-run"),
      dataClassification: "private",
      messages,
    });
    await f.service.save({
      runId: createRunId("history-run"),
      dataClassification: "private",
      messages: [...messages, { role: "user", content: "现在的天气怎么样？", timestamp: 4 }],
    });
    expect((await f.service.load(first, "private")).messages).toEqual(messages);
    await expect(f.service.load(first, "public")).rejects.toThrow();
  });
});
