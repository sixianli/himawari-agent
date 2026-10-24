import process from "node:process";
import { isWebProviderId, type WebProviderId } from "@himawari-agent/application";
import {
  createWebProvider,
  ExaPublicSearchAdapter,
  type WebProvider,
  type WebProviderSecrets,
} from "@himawari-agent/platform-node";

export async function readProgramInput(prefix: string): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16384) throw new Error(`${prefix}_INPUT_LIMIT`);
    chunks.push(bytes);
  }
  const input: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error(`${prefix}_INPUT_INVALID`);
  return input as Record<string, unknown>;
}

export function programProviders(value: unknown, prefix: string): readonly WebProviderId[] {
  if (value === undefined) return ["exa-public"];
  if (
    !Array.isArray(value) ||
    !value.length ||
    new Set(value).size !== value.length ||
    !value.every(isWebProviderId)
  )
    throw new Error(`${prefix}_INPUT_INVALID`);
  return value;
}

export function programSecrets(value: unknown, prefix: string): WebProviderSecrets {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${prefix}_INPUT_INVALID`);
  const entries = value as Record<string, unknown>;
  if (
    Object.keys(entries).some((key) => key !== "deepseek") ||
    (entries["deepseek"] !== undefined && typeof entries["deepseek"] !== "string")
  )
    throw new Error(`${prefix}_INPUT_INVALID`);
  return entries["deepseek"] === undefined ? {} : { deepseek: entries["deepseek"] as string };
}

export function programProvider(secrets: WebProviderSecrets) {
  return (id: WebProviderId): WebProvider =>
    id === "exa-public" ? new ExaPublicSearchAdapter() : createWebProvider(id, secrets);
}

export const providerSource: Readonly<Record<WebProviderId, string>> = {
  "exa-public": "Exa public web search",
  deepseek: "DeepSeek web search",
};
