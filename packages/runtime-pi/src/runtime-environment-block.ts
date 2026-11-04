import type { RuntimeProjection } from "@himawari-agent/application/runtime-port";
import { CHAT_CONTEXT_MATERIAL_MARKER, renderPrompt } from "@himawari-agent/prompt-catalog";

type ContextBlock = RuntimeProjection["contextBlocks"][number];

const CONTEXT_OPEN = "<himawari-context>\n";
const CONTEXT_CLOSE = "\n</himawari-context>\n";
const MARKER_PREFIX = "\n[Himawari context material ";
const RUNTIME_ENVIRONMENT_KIND = "runtime-environment";

export function contextBlockMarker(block: ContextBlock): string {
  const metadata = JSON.stringify({
    authority: block.authority,
    kind: block.kind,
    ref: block.ref,
    ...(block.sourceRef ? { sourceRef: block.sourceRef } : {}),
    ...(block.productRole ? { productRole: block.productRole } : {}),
  });
  return renderPrompt(CHAT_CONTEXT_MATERIAL_MARKER, { metadata });
}

function runtimeEnvironmentMarker(): string {
  return contextBlockMarker({
    authority: "non-authoritative",
    kind: RUNTIME_ENVIRONMENT_KIND,
    ref: RUNTIME_ENVIRONMENT_KIND,
    content: "",
    dataClassification: "public",
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function userTexts(message: Record<string, unknown>): string[] {
  const content = message["content"];
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) =>
    record(item) && item["type"] === "text" && typeof item["text"] === "string"
      ? [item["text"]]
      : [],
  );
}

function contextSegment(text: string): string | undefined {
  if (!text.startsWith(CONTEXT_OPEN)) return undefined;
  const end = text.indexOf(CONTEXT_CLOSE, CONTEXT_OPEN.length - 1);
  return end < 0 ? undefined : text.slice(CONTEXT_OPEN.length - 1, end);
}

function environmentIn(segment: string): string | undefined {
  const marker = `\n${runtimeEnvironmentMarker()}\n`;
  const start = segment.lastIndexOf(marker);
  if (start < 0) return undefined;
  const content = segment.slice(start + marker.length);
  const next = content.indexOf(MARKER_PREFIX);
  return next < 0 ? content : content.slice(0, next);
}

export function previousRuntimeEnvironment(messages: readonly unknown[]): string | undefined {
  let start = 0;
  messages.forEach((message, index) => {
    if (record(message) && message["role"] === "compactionSummary") start = index + 1;
  });
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index];
    if (!record(message) || message["role"] !== "user") continue;
    for (const text of userTexts(message).reverse()) {
      const segment = contextSegment(text);
      const found = segment === undefined ? undefined : environmentIn(segment);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function splitRuntimeEnvironment(projection: RuntimeProjection): {
  readonly blocks: readonly ContextBlock[];
  readonly environment: ContextBlock | undefined;
} {
  const environments = projection.contextBlocks.filter(
    ({ kind }) => kind === RUNTIME_ENVIRONMENT_KIND,
  );
  if (environments.length > 1) throw new TypeError("RUNTIME_PROJECTION_DUPLICATE_ENVIRONMENT");
  const [current] = environments;
  const blocks = projection.contextBlocks.filter(({ kind }) => kind !== RUNTIME_ENVIRONMENT_KIND);
  if (!current) return { blocks, environment: undefined };
  const environment: ContextBlock = {
    authority: "non-authoritative",
    kind: RUNTIME_ENVIRONMENT_KIND,
    ref: RUNTIME_ENVIRONMENT_KIND,
    content: current.content,
    dataClassification: current.dataClassification,
  };
  const previous = previousRuntimeEnvironment(projection.nativeHistory?.messages ?? []);
  return { blocks, environment: previous === current.content ? undefined : environment };
}
