import type { ProactiveMail, RuntimeToolInvocation } from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import {
  MailReadInputError,
  type MailThreadRead,
  ProductionMailRead,
} from "../src/production-mail-read.js";
import { productionToolActionRegistry } from "../src/production-tool-actions.js";

const mail = (
  id: string,
  receivedAt: string,
  extra: Partial<ProactiveMail> = {},
): ProactiveMail => ({
  source: "gmail",
  messageId: id,
  threadId: "thread-1",
  from: "田中",
  fromAddress: "tanaka@example.com",
  subject: "見積もりの件",
  snippet: `開頭 ${id}`,
  link: `https://mail.example.com/${id}`,
  receivedAt,
  categories: [],
  sentByOwner: false,
  body: `本文 ${id}`,
  bodyTruncated: false,
  bodyUnavailable: false,
  attachments: [],
  ...extra,
});

const call = (args: Record<string, unknown>) =>
  ({
    runId: "run-1",
    toolCallId: "call-1",
    capabilityRef: "owner.mail.read",
    capabilityHandleRef: null,
    arguments: args,
    dataClassification: "private",
  }) as unknown as RuntimeToolInvocation;

const reading = (result: MailThreadRead) => {
  const asked: string[] = [];
  const tool = new ProductionMailRead(() => ({
    async readMailThread(threadId) {
      asked.push(threadId);
      return result;
    },
  }));
  return { tool, asked };
};

describe("mail_read reads one whole mail thread for her", () => {
  it("returns every mail of the thread from earliest to latest, with the owner's own replies and what was not read in full", async () => {
    const { tool, asked } = reading({
      kind: "thread",
      mails: [
        mail("m-3", "2026-11-03T00:00:00.000Z", { sentByOwner: true }),
        mail("m-1", "2026-11-01T00:00:00.000Z", {
          attachments: [{ filename: "見積書.pdf" } as ProactiveMail["attachments"][number]],
        }),
        mail("m-2", "2026-11-02T00:00:00.000Z", { body: null, bodyUnavailable: true }),
      ],
    });
    const result = (await tool.run(call({ threadId: " thread-1 " }))) as {
      status: string;
      total: number;
      mails: {
        id: string;
        text: string;
        complete: boolean;
        sentByOwner: boolean;
        attachments: string[];
      }[];
    };
    expect(asked).toEqual(["thread-1"]);
    expect(result.status).toBe("thread");
    expect(result.total).toBe(3);
    expect(result.mails.map(({ id }) => id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(result.mails[0]).toMatchObject({
      text: "本文 m-1",
      complete: true,
      attachments: ["見積書.pdf"],
    });
    expect(result.mails[1]).toMatchObject({ text: "開頭 m-2", complete: false });
    expect(result.mails[2]?.sentByOwner).toBe(true);
  });

  it("keeps only the latest 30 mails of a long thread and says how many earlier ones were left out", async () => {
    const mails = Array.from({ length: 33 }, (_, index) =>
      mail(`m-${index}`, new Date(Date.UTC(2026, 10, 1, index)).toISOString()),
    );
    const { tool } = reading({ kind: "thread", mails });
    const result = (await tool.run(call({ threadId: "thread-1" }))) as {
      omittedEarlier: number;
      mails: { id: string }[];
    };
    expect(result.omittedEarlier).toBe(3);
    expect(result.mails).toHaveLength(30);
    expect(result.mails[0]?.id).toBe("m-3");
  });

  it("[reverse] says the mailbox is not connected or the thread is missing instead of inventing mail", async () => {
    for (const kind of ["not_connected", "not_found", "failed", "unsupported"] as const)
      expect(await reading({ kind }).tool.run(call({ threadId: "thread-1" }))).toEqual({
        status: kind,
      });
    expect(await new ProductionMailRead(() => undefined).run(call({ threadId: "t" }))).toEqual({
      status: "unsupported",
    });
  });

  it("[reverse] rejects a missing, blank or extra argument without reading the mailbox", async () => {
    const { tool, asked } = reading({ kind: "thread", mails: [] });
    for (const args of [{}, { threadId: "  " }, { threadId: 7 }, { threadId: "t", limit: 5 }])
      await expect(tool.run(call(args))).rejects.toBeInstanceOf(MailReadInputError);
    expect(asked).toEqual([]);
  });

  it("is a read whose result counts as outside content", () => {
    const row = productionToolActionRegistry().forTool("mail_read");
    expect(row).toMatchObject({
      actionKind: "READ",
      sideEffect: "none",
      resultOrigin: "external",
      authorization: "read",
      executor: "owner_scoped",
    });
  });
});
