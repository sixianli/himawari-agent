export const PROACTIVE_BODY_OMISSION_MARKER = "\n……（中间省略）……\n";

const HEAD_SHARE = 0.7;

export interface WindowedBody {
  readonly text: string;
  readonly truncated: boolean;
}

export function windowMailBody(body: string, limit: number): WindowedBody {
  const points = Array.from(body);
  if (points.length <= limit) return Object.freeze({ text: body, truncated: false });
  const marker = Array.from(PROACTIVE_BODY_OMISSION_MARKER);
  const room = Math.max(0, limit - marker.length);
  const head = Math.ceil(room * HEAD_SHARE);
  const tail = room - head;
  const kept = [
    ...points.slice(0, head),
    ...marker,
    ...(tail > 0 ? points.slice(points.length - tail) : []),
  ];
  return Object.freeze({ text: kept.join(""), truncated: true });
}

function isHiddenCodePoint(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    code === 0x7f ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f)
  );
}

function stripHidden(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (!isHiddenCodePoint(code)) out += character;
  }
  return out;
}

export function plainModelText(value: string, limit: number): string {
  return stripHidden(value)
    .replace(/<\/?[A-Za-z!][^>]*>/gu, " ")
    .replace(/\b(?:https?|ftp):\/\/\S+/giu, "")
    .replace(/\bwww\.\S+/giu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}
