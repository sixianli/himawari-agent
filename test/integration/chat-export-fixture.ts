import { putPayload, type Side, T0 } from "./data-export-fixture.ts";

export interface MessageSeed {
  readonly text: string;
  readonly role?: "owner" | "agent" | "system";
  readonly status?: "committed" | "partial" | "failed";
  readonly classification?: "public" | "private" | "sensitive" | "restricted";
  readonly internal?: true;
}

export async function seedThread(
  s: Side,
  id: string,
  options: {
    readonly title?: string | null;
    readonly status?: string;
    readonly created?: string;
    readonly pinned?: boolean;
    readonly messages: readonly MessageSeed[];
  },
): Promise<void> {
  const titleRef =
    options.title === null || options.title === undefined
      ? null
      : await putPayload(s, `title-${id}`, options.title);
  s.database
    .prepare(
      `INSERT INTO threads (id, owner_id, agent_id, revision, status, title_ref, title_source,
        pin_order, answer_locale, message_watermark, archived_at, trashed_at, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'zh-CN', ?, NULL, ?, ?, ?)`,
    )
    .run(
      id,
      s.ownerId,
      s.agentId,
      options.status ?? "open",
      titleRef,
      titleRef === null ? null : "owner",
      options.pinned === true ? 0 : null,
      options.messages.length,
      options.status === "trashed" ? T0 : null,
      options.created ?? T0,
      "2026-11-02T00:00:00.000Z",
    );
  let sequence = 0;
  for (const message of options.messages) {
    sequence += 1;
    const classification = message.classification ?? "private";
    const ref = await putPayload(s, `msg-${id}-${sequence}`, message.text, classification);
    s.database
      .prepare(
        `INSERT INTO thread_messages (id, owner_id, agent_id, thread_id, revision, sequence, role,
          content_ref, classification, committed_at, message_status, internal)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${id}-m${sequence}`,
        s.ownerId,
        s.agentId,
        id,
        sequence,
        message.role ?? (sequence % 2 === 1 ? "owner" : "agent"),
        ref,
        classification,
        `2026-11-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
        message.status ?? "committed",
        message.internal === true ? 1 : 0,
      );
  }
}
