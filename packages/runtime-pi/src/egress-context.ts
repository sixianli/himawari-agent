import type { Context } from "@earendil-works/pi-ai";
import {
  EGRESS_PLACEHOLDER_LEGEND,
  redactForEgress,
} from "@himawari-agent/application/runtime-port";

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    const redacted = redactForEgress(value).text;
    return redacted === value ? value : redacted;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = redactValue(item);
      if (result !== item) changed = true;
      return result;
    });
    return changed ? next : value;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = redactValue(item);
      if (result !== item) changed = true;
      next[key] = result;
    }
    return changed ? next : value;
  }
  return value;
}

function redactPart(part: unknown): unknown {
  if (typeof part !== "object" || part === null) return part;
  const type = (part as { type?: unknown }).type;
  if (type === "text") {
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" && redactForEgress(text).text !== text
      ? { ...part, text: redactForEgress(text).text }
      : part;
  }
  if (type === "toolCall") {
    const args = (part as { arguments?: unknown }).arguments;
    const next = redactValue(args);
    return next === args ? part : { ...part, arguments: next };
  }
  return part;
}

function redactMessage(message: unknown): unknown {
  if (typeof message !== "object" || message === null) return message;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    const redacted = redactForEgress(content).text;
    return redacted === content ? message : { ...message, content: redacted };
  }
  if (Array.isArray(content)) {
    let changed = false;
    const next = content.map((part) => {
      const result = redactPart(part);
      if (result !== part) changed = true;
      return result;
    });
    return changed ? { ...message, content: next } : message;
  }
  return message;
}

export function redactModelContext(context: Context): Context {
  const systemPrompt =
    context.systemPrompt === undefined
      ? EGRESS_PLACEHOLDER_LEGEND
      : `${context.systemPrompt}\n\n${EGRESS_PLACEHOLDER_LEGEND}`;
  return {
    ...context,
    systemPrompt,
    messages: context.messages.map((message) => redactMessage(message) as typeof message),
  };
}
