import {
  APPROVAL_BODY_PREVIEW_DEFAULT_CHARACTERS,
  APPROVAL_BODY_PREVIEW_MAXIMUM_CHARACTERS,
  type ApprovalDisplayInput,
  approvalBodyPreview,
} from "@himawari-agent/application";

export interface ApprovalDisplayRequest {
  readonly threadId: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type ApprovalDisplayBuilder = (
  request: ApprovalDisplayRequest,
) => () => Promise<ApprovalDisplayInput>;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

function editText(args: Readonly<Record<string, unknown>>): string | null {
  const edits = Array.isArray(args["edits"]) ? args["edits"] : [args];
  const lines = edits.flatMap((edit: unknown) => {
    if (edit === null || typeof edit !== "object") return [];
    const record = edit as Record<string, unknown>;
    const before = text(record["oldText"]);
    const after = typeof record["newText"] === "string" ? record["newText"] : null;
    if (before === null && after === null) return [];
    return [`- ${before ?? ""}`, `+ ${after ?? ""}`];
  });
  return lines.length === 0 ? null : lines.join("\n");
}

export function toolApprovalBodyText(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): string | null {
  switch (tool) {
    case "bash":
      return text(args["command"]);
    case "write":
      return text(args["content"]) ?? text(args["path"]);
    case "edit":
      return editText(args) ?? text(args["path"]);
    case "web_search":
      return text(args["query"]);
    case "web_fetch":
      return text(args["url"]);
    case "move_directory": {
      const from = text(args["path"]);
      const to = text(args["destination"]);
      return from && to ? `${from} → ${to}` : (from ?? to);
    }
    case "read":
    case "ls":
    case "find":
    case "grep":
      return text(args["pattern"]) ?? text(args["path"]);
    default:
      return null;
  }
}

export function createApprovalDisplayBuilder(options: {
  readonly threadTitle?: (threadId: string) => Promise<string | null>;
  readonly maximumCharacters?: number;
}): ApprovalDisplayBuilder {
  const maximum = Math.min(
    options.maximumCharacters ?? APPROVAL_BODY_PREVIEW_DEFAULT_CHARACTERS,
    APPROVAL_BODY_PREVIEW_MAXIMUM_CHARACTERS,
  );
  return (request) => async () => {
    const body = toolApprovalBodyText(request.tool, request.arguments);
    let title: string | null = null;
    try {
      title = options.threadTitle ? await options.threadTitle(request.threadId) : null;
    } catch {
      title = null;
    }
    return {
      displayTitle: null,
      bodyPreview: body === null ? null : approvalBodyPreview(body, maximum),
      origin: {
        threadId: request.threadId,
        threadTitle: title === null ? null : (approvalBodyPreview(title, 120) ?? null),
      },
    };
  };
}
