import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function sources(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "test"].includes(entry.name)) continue;
      found.push(...(await sources(full)));
    } else if (/\.(ts|tsx)$/u.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

async function filesUsing(pattern: RegExp): Promise<string[]> {
  const files = [
    ...(await sources(path.join(ROOT, "apps"))),
    ...(await sources(path.join(ROOT, "packages"))),
  ];
  const hits: string[] = [];
  for (const file of files)
    if (pattern.test(await readFile(file, "utf8"))) hits.push(path.relative(ROOT, file));
  return hits.sort();
}

describe("[P3-6] recent conversation summaries reach only the Gmail check and the external read entry", () => {
  it("keeps the summary block, the reader and its wiring out of the chat path", async () => {
    expect(await filesUsing(/MAIL_JUDGMENT_RECENT_SUMMARIES_HEADER/u)).toEqual([
      "packages/application/src/services/proactive-mail-check-service.ts",
      "packages/prompt-catalog/src/mail.ts",
    ]);
    expect(await filesUsing(/createProactiveRecentSummaries/u)).toEqual([
      "apps/agent-service/src/production-proactive-summaries.ts",
      "apps/agent-service/src/service-main.ts",
    ]);
    expect(await filesUsing(/listDaySummaries\b/u)).toEqual([
      "packages/application/src/ports/memory-episodes.ts",
      "packages/memory-engine/src/episodes.ts",
      "packages/persistence-sqlite/src/durable-adapters.ts",
      "packages/persistence-sqlite/src/sqlite-memory-operations.ts",
    ]);
    expect(await filesUsing(/listDaySummariesAfter/u)).toEqual([
      "apps/agent-service/src/production-memory-conversation-review.ts",
      "packages/application/src/ports/memory-episodes.ts",
      "packages/persistence-sqlite/src/durable-adapters.ts",
      "packages/persistence-sqlite/src/sqlite-memory-operations.ts",
    ]);
    expect(
      await readFile(
        path.join(ROOT, "apps/agent-service/src/production-memory-conversation-review.ts"),
        "utf8",
      ),
    ).not.toMatch(/episode\.contentRef/u);
    expect(await filesUsing(/\.recent\(\{/u)).toEqual([
      "apps/agent-service/src/production-proactive-summaries.ts",
      "apps/agent-service/src/service-main.ts",
      "packages/application/src/services/proactive-mail-check-service.ts",
    ]);
    expect(await filesUsing(/recentSummaries/u)).toEqual([
      "apps/agent-service/src/production-proactive.ts",
      "apps/agent-service/src/service-main.ts",
      "packages/application/src/services/proactive-mail-check-service.ts",
    ]);
  });
});
