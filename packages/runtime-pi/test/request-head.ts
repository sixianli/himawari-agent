import { normalizeContext, type TranscriptContext } from "@earendil-works/pi-ai";

export async function requestContextFor(
  rawOptions: Readonly<Record<string, unknown>>,
): Promise<TranscriptContext> {
  const loader = rawOptions["resourceLoader"] as {
    reload(): Promise<void>;
    getSystemPrompt(): string | undefined;
  };
  await loader.reload();
  const systemPrompt = loader.getSystemPrompt();
  return normalizeContext({
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    messages: [],
  });
}
