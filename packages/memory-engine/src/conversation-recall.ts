import { type DataClassification, highestClassification } from "@himawari-agent/application";
import {
  CONVERSATION_RECALL_HEADER,
  CONVERSATION_RECALL_LINE_DAY,
  CONVERSATION_RECALL_TURN,
  renderPrompt,
} from "@himawari-agent/prompt-catalog";
import type { ConversationLine, ConversationTurnHit } from "./conversation-turns.js";
import { localDay } from "./episodes.js";

export interface RecalledConversationTurn {
  readonly conversationId: string;
  readonly sequence: number;
  readonly day: string;
  readonly startedAt: string;
  readonly preview: string;
}

export interface ConversationRecallText {
  readonly text: string;
  readonly dataClassification: DataClassification;
  readonly turns: readonly RecalledConversationTurn[];
}

const PREVIEW_CHARACTERS = 80;

function characters(text: string): number {
  return [...text].length;
}

function clipped(text: string, maximum: number): string {
  const all = [...text];
  return all.length <= maximum ? text : `${all.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

function speaker(line: ConversationLine): string {
  return line.role === "owner" ? "主人" : "你";
}

function matched(hit: ConversationTurnHit): readonly ConversationLine[] {
  const own = hit.lines.filter(
    (line) => line.sequence >= hit.turn.firstSequence && line.sequence <= hit.turn.lastSequence,
  );
  return own.length > 0 ? own : hit.lines;
}

function turnText(
  threadId: string,
  lines: readonly ConversationLine[],
  room: number,
  timeZone: string | undefined,
): string | undefined {
  const first = lines[0];
  if (!first) return undefined;
  const day = localDay(first.committedAt, timeZone);
  const head = renderPrompt(CONVERSATION_RECALL_TURN, {
    day,
    conversationId: threadId,
    sequence: String(first.sequence),
  });
  const body = lines
    .map((line) => {
      const own = localDay(line.committedAt, timeZone);
      const said = `${speaker(line)}：${line.text}`;
      return own === day
        ? said
        : `${renderPrompt(CONVERSATION_RECALL_LINE_DAY, { day: own })}${said}`;
    })
    .join("\n");
  const whole = `${head}\n${body}`;
  if (characters(whole) <= room) return whole;
  const left = room - characters(head) - 1;
  return left > 0 ? `${head}\n${clipped(body, left)}` : undefined;
}

export function conversationRecallText(
  hits: readonly ConversationTurnHit[],
  options: { readonly maximumCharacters: number; readonly timeZone?: string },
): ConversationRecallText | undefined {
  const header = CONVERSATION_RECALL_HEADER.text;
  let room = options.maximumCharacters - characters(header);
  const chosen: { hit: ConversationTurnHit; day: string; room: number }[] = [];
  for (const hit of hits) {
    const whole = turnText(
      hit.turn.threadId,
      hit.lines,
      Number.POSITIVE_INFINITY,
      options.timeZone,
    );
    if (whole === undefined) continue;
    const fits = characters(whole) + 2 <= room;
    if (!fits && chosen.length > 0) continue;
    const budget = fits ? Number.POSITIVE_INFINITY : room - 2;
    const text = turnText(hit.turn.threadId, hit.lines, budget, options.timeZone);
    if (text === undefined) continue;
    chosen.push({ hit, day: localDay(hit.turn.startedAt, options.timeZone), room: budget });
    room -= characters(text) + 2;
  }
  if (chosen.length === 0) return undefined;
  chosen.sort(
    (left, right) =>
      left.hit.turn.startedAt.localeCompare(right.hit.turn.startedAt) ||
      left.hit.turn.id.localeCompare(right.hit.turn.id),
  );
  const shownLines = new Set<string>();
  const blocks = chosen.flatMap(({ hit, room: budget }) => {
    const fresh = hit.lines.filter((line) => {
      const key = `${hit.turn.threadId}\u0000${line.sequence}`;
      if (shownLines.has(key)) return false;
      shownLines.add(key);
      return true;
    });
    const text = turnText(hit.turn.threadId, fresh, budget, options.timeZone);
    return text === undefined ? [] : [text];
  });
  return Object.freeze({
    text: [header, ...blocks].join("\n\n"),
    dataClassification: highestClassification(
      "private",
      chosen.flatMap(({ hit }) => hit.lines.map((line) => line.dataClassification)),
    ),
    turns: Object.freeze(
      chosen.map(({ hit, day }) =>
        Object.freeze({
          conversationId: hit.turn.threadId,
          sequence: hit.turn.firstSequence,
          day,
          startedAt: hit.turn.startedAt,
          preview: clipped(
            (matched(hit).find((line) => line.role === "owner") ?? matched(hit)[0])?.text.replace(
              /\s+/gu,
              " ",
            ) ?? "",
            PREVIEW_CHARACTERS,
          ),
        }),
      ),
    ),
  });
}
