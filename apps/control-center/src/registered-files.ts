export const REGISTERED_FILE_KINDS = [
  "document",
  "code",
  "web",
  "image",
  "pdf",
  "data",
  "other",
] as const;
export type RegisteredFileKind = (typeof REGISTERED_FILE_KINDS)[number];

export interface RegisteredFile {
  readonly id: string;
  readonly threadId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolItemId: string;
  readonly source: "write" | "edit" | "bash" | "upload";
  readonly path: string;
  readonly name: string;
  readonly kind: RegisteredFileKind;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly version: number;
  readonly turn: number;
  readonly commandKey: string | null;
  readonly stored: boolean;
  readonly overlapped: boolean;
  readonly createdAt: string;
  readonly deleted: boolean;
}

export interface RegisteredFilePage {
  readonly items: readonly RegisteredFile[];
  readonly nextCursor: string | null;
}

const SOURCES = new Set(["write", "edit", "bash", "upload"]);

export function parseRegisteredFile(value: unknown): RegisteredFile {
  const item =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const text = (key: string) => {
    const field = item[key];
    if (typeof field !== "string" || field.length === 0)
      throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
    return field;
  };
  const count = (key: string, minimum: number) => {
    const field = item[key];
    if (!Number.isSafeInteger(field) || (field as number) < minimum)
      throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
    return field as number;
  };
  const source = text("source");
  const kind = text("kind");
  if (!SOURCES.has(source) || !REGISTERED_FILE_KINDS.includes(kind as RegisteredFileKind))
    throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
  if (typeof item["stored"] !== "boolean" || typeof item["overlapped"] !== "boolean")
    throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
  const commandKey = item["commandKey"];
  if (commandKey !== null && typeof commandKey !== "string")
    throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
  return Object.freeze({
    id: text("id"),
    threadId: text("threadId"),
    runId: text("runId"),
    toolCallId: text("toolCallId"),
    toolItemId: text("toolItemId"),
    source: source as RegisteredFile["source"],
    path: text("path"),
    name: text("name"),
    kind: kind as RegisteredFileKind,
    mediaType: text("mediaType"),
    sizeBytes: count("sizeBytes", 0),
    version: count("version", 1),
    turn: count("turn", 0),
    commandKey,
    stored: item["stored"],
    overlapped: item["overlapped"],
    createdAt: text("createdAt"),
    deleted: item["deleted"] === true,
  });
}

export function parseRegisteredFilePage(value: unknown): RegisteredFilePage {
  const body =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const nextCursor = body["nextCursor"] ?? null;
  if (!Array.isArray(body["items"]) || (nextCursor !== null && typeof nextCursor !== "string"))
    throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
  return Object.freeze({
    items: Object.freeze(body["items"].map(parseRegisteredFile)),
    nextCursor,
  });
}
