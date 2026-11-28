import { type DataClassification, highestClassification } from "@himawari-agent/application";
import {
  CONVERSATION_RECALL_HEADER,
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

function turnText(hit: ConversationTurnHit, day: string, room: number): string | undefined {
  const head = renderPrompt(CONVERSATION_RECALL_TURN, {
    day,
    conversationId: hit.turn.threadId,
    sequence: String(hit.turn.firstSequence),
  });
  const body = hit.lines.map((line) => `${speaker(line)}：${line.text}`).join("\n");
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
  const chosen: { hit: ConversationTurnHit; day: string; text: string }[] = [];
  for (const hit of hits) {
    const day = localDay(hit.turn.startedAt, options.timeZone);
    const whole = turnText(hit, day, Number.POSITIVE_INFINITY) ?? "";
    const fits = characters(whole) + 2 <= room;
    const text = fits ? whole : chosen.length === 0 ? turnText(hit, day, room - 2) : undefined;
    if (text === undefined) continue;
    chosen.push({ hit, day, text });
    room -= characters(text) + 2;
  }
  if (chosen.length === 0) return undefined;
  chosen.sort(
    (left, right) =>
      left.hit.turn.startedAt.localeCompare(right.hit.turn.startedAt) ||
      left.hit.turn.id.localeCompare(right.hit.turn.id),
  );
  return Object.freeze({
    text: [header, ...chosen.map(({ text }) => text)].join("\n\n"),
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
            (hit.lines.find((line) => line.role === "owner") ?? hit.lines[0])?.text.replace(
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
