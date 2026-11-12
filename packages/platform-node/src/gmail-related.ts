import type {
  ProactiveRelatedFetch,
  ProactiveRelatedLimits,
  ProactiveSourceItem,
  ProactiveWholeThread,
} from "@himawari-agent/application";

const SUBJECT_PREFIX =
  /^\s*(?:(?:re|fwd?|fw|aw|wg|sv|vs|tr|回复|回覆|答复|转发|返信|転送)\s*[:：]\s*)+/iu;
const MIN_SUBJECT_CHARACTERS = 6;
const SEARCH_RESULTS = 5;
const FETCH_PARALLEL = 5;

export function normalizeSubject(subject: string): string {
  return subject.replace(SUBJECT_PREFIX, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

export function counterparts(item: ProactiveSourceItem): readonly string[] {
  if (!item.sentByOwner) return item.fromAddress === "" ? [] : [item.fromAddress];
  return (item.participants ?? []).filter((address) => address !== item.fromAddress);
}

function sharesCounterpart(item: ProactiveSourceItem, other: ProactiveSourceItem): boolean {
  const mine = counterparts(item);
  if (mine.length === 0) return false;
  const theirs = new Set([other.fromAddress, ...(other.participants ?? [])]);
  return mine.some((address) => theirs.has(address));
}

function mentions(candidate: ProactiveSourceItem, reference: string): boolean {
  const haystack = `${candidate.subject}\n${candidate.body ?? candidate.snippet}`.toUpperCase();
  let from = haystack.indexOf(reference);
  while (from >= 0) {
    const before = haystack[from - 1] ?? "";
    const after = haystack[from + reference.length] ?? "";
    const afterNext = haystack[from + reference.length + 1] ?? "";
    const longerAfter = /[A-Z0-9]/u.test(after) || (after === "-" && /[A-Z0-9]/u.test(afterNext));
    if (!/[A-Z0-9-]/u.test(before) && !longerAfter) return true;
    from = haystack.indexOf(reference, from + 1);
  }
  return false;
}

function isEarlier(candidate: ProactiveSourceItem, item: ProactiveSourceItem): boolean {
  return (
    candidate.receivedAt < item.receivedAt ||
    (candidate.receivedAt === item.receivedAt && candidate.messageId < item.messageId)
  );
}

function chronological(left: ProactiveSourceItem, right: ProactiveSourceItem): number {
  return (
    left.receivedAt.localeCompare(right.receivedAt) || left.messageId.localeCompare(right.messageId)
  );
}

export interface GmailRelatedTransport {
  thread(threadId: string): Promise<readonly ProactiveSourceItem[] | undefined>;
  search(query: string, maxResults: number): Promise<readonly string[] | undefined>;
  message(id: string): Promise<ProactiveSourceItem | undefined>;
}

class Budget {
  used = 0;
  readonly total: number;
  constructor(total: number) {
    this.total = total;
  }
  take(): boolean {
    if (this.used >= this.total) return false;
    this.used += 1;
    return true;
  }
}

export async function findRelatedMail(input: {
  readonly items: readonly ProactiveSourceItem[];
  readonly limits: ProactiveRelatedLimits;
  readonly wholeThread?: ReadonlySet<string>;
  readonly references?: ReadonlyMap<string, readonly string[]>;
  readonly signal: AbortSignal;
  readonly transport: GmailRelatedTransport;
}): Promise<ProactiveRelatedFetch> {
  const { items, limits, signal, transport } = input;
  const wholeThread = new Map<string, ProactiveWholeThread>();
  const budget = new Budget(limits.requestsPerCheck);
  const known = new Map<string, ProactiveSourceItem | null>();
  const byMail = new Map<string, readonly ProactiveSourceItem[]>();
  const failed = new Map<string, string>();

  const fetchMessage = async (id: string): Promise<ProactiveSourceItem | undefined> => {
    if (known.has(id)) return known.get(id) ?? undefined;
    if (!budget.take()) throw new RelatedStop("budget");
    const message = await transport.message(id);
    known.set(id, message ?? null);
    return message;
  };

  const search = async (query: string): Promise<readonly string[]> => {
    if (!budget.take()) throw new RelatedStop("budget");
    return (await transport.search(query, SEARCH_RESULTS)) ?? [];
  };

  const fetchMany = async (ids: readonly string[]): Promise<ProactiveSourceItem[]> => {
    const found: ProactiveSourceItem[] = [];
    for (let start = 0; start < ids.length; start += FETCH_PARALLEL) {
      const chunk = await Promise.all(ids.slice(start, start + FETCH_PARALLEL).map(fetchMessage));
      for (const message of chunk) if (message) found.push(message);
    }
    return found;
  };

  for (const item of items) {
    if (signal.aborted) {
      failed.set(item.messageId, "timeout");
      continue;
    }
    const pool = new Map<string, ProactiveSourceItem>();
    const threadMessages: ProactiveSourceItem[] = [];
    let threadRead = false;
    const add = (candidate: ProactiveSourceItem) => {
      if (candidate.messageId !== item.messageId && isEarlier(candidate, item))
        pool.set(candidate.messageId, candidate);
    };
    let step = "thread";
    try {
      if (!budget.take()) throw new RelatedStop("budget");
      const listed = await transport.thread(item.threadId);
      for (const message of listed ?? []) {
        known.set(message.messageId, message);
        add(message);
        if (message.messageId !== item.messageId && !message.categories.includes("spam"))
          threadMessages.push(message);
      }
      threadRead = listed !== undefined;
      step = "subject";
      const subject = normalizeSubject(item.subject);
      if (Array.from(subject).length >= MIN_SUBJECT_CHARACTERS && counterparts(item).length > 0) {
        const ids = await search(`subject:"${subject.replace(/"/gu, "")}" -in:trash -in:spam`);
        for (const message of await fetchMany(ids.filter((id) => id !== item.messageId)))
          if (normalizeSubject(message.subject) === subject && sharesCounterpart(item, message))
            add(message);
      }
      step = "reference";
      const references = input.references?.get(item.messageId) ?? [];
      for (const reference of references) {
        const ids = await search(`"${reference}" -in:trash -in:spam`);
        for (const message of await fetchMany(ids.filter((id) => id !== item.messageId)))
          if (mentions(message, reference)) add(message);
      }
    } catch (error) {
      if (!(error instanceof RelatedStop) && signal.aborted) step = "timeout";
      else if (error instanceof RelatedStop) step = error.step;
      failed.set(item.messageId, step);
    }
    const ordered = [...pool.values()]
      .filter(({ categories }) => !categories.includes("spam"))
      .sort(chronological);
    if (input.wholeThread?.has(item.messageId)) {
      const thread = [...threadMessages].sort(chronological);
      const kept = thread.slice(-limits.wholeThreadPerMail);
      const chosen = new Map<string, ProactiveSourceItem>();
      for (const message of [...kept, ...ordered.slice(-limits.perMail)])
        chosen.set(message.messageId, message);
      byMail.set(item.messageId, [...chosen.values()].sort(chronological));
      wholeThread.set(item.messageId, {
        messageIds: thread.map(({ messageId }) => messageId),
        complete: threadRead && kept.length === thread.length,
      });
    } else byMail.set(item.messageId, ordered.slice(-limits.perMail));
  }
  return { byMail, failed, requests: budget.used, wholeThread };
}

class RelatedStop extends Error {
  readonly step: string;
  constructor(step: string) {
    super(step);
    this.step = step;
  }
}
