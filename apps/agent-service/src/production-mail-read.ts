import {
  type ProactiveMail,
  plainModelText,
  type RuntimeToolDescriptor,
  type RuntimeToolInvocation,
  windowMailBody,
} from "@himawari-agent/application";
import { TOOL_MAIL_READ } from "@himawari-agent/prompt-catalog";

export const MAIL_READ_CAPABILITY_REF = "owner.mail.read";
const THREAD_ID_LIMIT = 256;
const QUERY_LIMIT = 500;
const SEARCH_RESULTS = 20;
const BODY_LIMIT = 6000;
const MAIL_LIMIT = 30;
const READ_TIMEOUT_MS = 30_000;

export class MailReadInputError extends Error {
  readonly code = "MAIL_READ_INPUT_INVALID";

  constructor() {
    super("MAIL_READ_INPUT_INVALID");
    this.name = "MailReadInputError";
  }
}

export type MailThreadRead =
  | { readonly kind: "thread"; readonly mails: readonly ProactiveMail[] }
  | { readonly kind: "not_connected" | "not_found" | "unsupported" | "failed" };

export type MailSearch =
  | { readonly kind: "found"; readonly mails: readonly ProactiveMail[] }
  | { readonly kind: "not_connected" | "unsupported" | "failed" };

export interface MailThreadReader {
  readMailThread(threadId: string, signal: AbortSignal): Promise<MailThreadRead>;
  searchMail(query: string, limit: number, signal: AbortSignal): Promise<MailSearch>;
}

export function mailReadDescriptor(): RuntimeToolDescriptor {
  return {
    name: "mail_read",
    capabilityRef: MAIL_READ_CAPABILITY_REF,
    capabilityHandleRef: null,
    description: TOOL_MAIL_READ.text,
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", minLength: 1, maxLength: THREAD_ID_LIMIT },
        query: { type: "string", minLength: 1, maxLength: QUERY_LIMIT },
      },
      additionalProperties: false,
    },
  };
}

export class ProductionMailRead {
  readonly #reader: () => MailThreadReader | undefined;

  constructor(reader: () => MailThreadReader | undefined) {
    this.#reader = reader;
  }

  async run(invocation: RuntimeToolInvocation): Promise<Record<string, unknown>> {
    const args = invocation.arguments;
    const names = Object.keys(args);
    if (names.length !== 1 || !["threadId", "query"].includes(names[0] as string))
      throw new MailReadInputError();
    const query = args["query"];
    if (query !== undefined) {
      if (typeof query !== "string" || query.trim().length === 0 || query.length > QUERY_LIMIT)
        throw new MailReadInputError();
      const reader = this.#reader();
      if (!reader) return { status: "unsupported" };
      const found = await reader.searchMail(
        query.trim(),
        SEARCH_RESULTS,
        AbortSignal.timeout(READ_TIMEOUT_MS),
      );
      if (found.kind !== "found") return { status: found.kind };
      return {
        status: "found",
        query: query.trim(),
        mails: [...found.mails]
          .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
          .map((mail) => ({
            id: mail.messageId,
            threadId: mail.threadId,
            from: mail.from,
            receivedAt: mail.receivedAt,
            subject: mail.subject,
            sentByOwner: mail.sentByOwner,
            snippet: plainModelText(mail.snippet, 600),
          })),
      };
    }
    const threadId = args["threadId"];
    if (
      typeof threadId !== "string" ||
      threadId.trim().length === 0 ||
      threadId.length > THREAD_ID_LIMIT
    )
      throw new MailReadInputError();
    const reader = this.#reader();
    if (!reader) return { status: "unsupported" };
    const read = await reader.readMailThread(threadId.trim(), AbortSignal.timeout(READ_TIMEOUT_MS));
    if (read.kind !== "thread") return { status: read.kind };
    const sorted = [...read.mails].sort((left, right) =>
      left.receivedAt.localeCompare(right.receivedAt),
    );
    const kept = sorted.slice(-MAIL_LIMIT);
    return {
      status: "thread",
      threadId: threadId.trim(),
      total: sorted.length,
      ...(kept.length < sorted.length ? { omittedEarlier: sorted.length - kept.length } : {}),
      mails: kept.map(mailView),
    };
  }
}

function mailView(mail: ProactiveMail) {
  const body = mail.body === null ? null : windowMailBody(mail.body, BODY_LIMIT);
  return {
    id: mail.messageId,
    from: mail.from,
    receivedAt: mail.receivedAt,
    subject: mail.subject,
    sentByOwner: mail.sentByOwner,
    attachments: mail.attachments.map(({ filename }) => filename),
    text: plainModelText(body?.text ?? mail.snippet, BODY_LIMIT + 100),
    complete: body !== null && !body.truncated && !mail.bodyTruncated && !mail.bodyUnavailable,
  };
}
