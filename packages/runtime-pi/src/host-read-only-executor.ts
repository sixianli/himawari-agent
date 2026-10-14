import path from "node:path";
import {
  createFindToolDefinition,
  createLsToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import {
  assertMachineSecretFree,
  firstProtectedDirectoryEntry,
  firstRejectedPathComponent,
  HOST_READ_ONLY_ERROR_CODES,
  HostReadOnlyError,
  type HostDirectoryGrant,
  type HostReadOnlyEntryKind,
  type HostReadOnlyPort,
} from "@himawari-agent/application/runtime-port";
import ignore from "ignore";

const GREP_MAX_LINE_LENGTH = 500;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"] as const;
const IGNORE_FILE_BYTES = 1024 * 1024;
const ALWAYS_SKIPPED_NAMES = new Set(["node_modules", ".git"]);

export type HostReadOnlyToolName = "read" | "ls" | "find" | "grep";

export interface HostReadOnlyToolInput {
  readonly port: HostReadOnlyPort;
  readonly grant: HostDirectoryGrant;
  readonly tool: HostReadOnlyToolName;
  readonly toolCallId: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly relativePath: string;
  readonly readBytesLimit: number;
  readonly signal?: AbortSignal;
}

export interface HostReadOnlyToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly errorCode: string | null;
  readonly details?: unknown;
}

const DIRECTORY_READ_MESSAGE =
  "目标路径是目录，不是文件。查看目录内容请用 ls；找到具体文件后，再对那个文件路径调用 read。";

function errorResult(code: string, message: string): HostReadOnlyToolResult {
  return { content: message, isError: true, errorCode: code };
}

function knownError(error: unknown): HostReadOnlyError | undefined {
  return error instanceof HostReadOnlyError ? error : undefined;
}

function protectedComponents(relativePath: string): boolean {
  if (relativePath === "") return false;
  return firstProtectedDirectoryEntry(relativePath.split("/")) !== undefined;
}

function rejectedComponents(relativePath: string): boolean {
  if (relativePath === "") return false;
  return firstRejectedPathComponent(relativePath.split("/")) !== undefined;
}

export async function executeHostReadOnlyTool(
  input: HostReadOnlyToolInput,
): Promise<HostReadOnlyToolResult> {
  if (!input.port.available)
    return errorResult(HOST_READ_ONLY_ERROR_CODES.PROC_UNAVAILABLE, "PI_READ_PROC_UNAVAILABLE");
  if (!input.parameters || typeof input.parameters !== "object" || Array.isArray(input.parameters))
    return errorResult("PI_TOOL_ARGUMENTS_INVALID", "PI_TOOL_ARGUMENTS_INVALID");
  if (rejectedComponents(input.relativePath))
    return errorResult("PI_PATH_OUTSIDE_SCOPE", "PI_PATH_OUTSIDE_SCOPE");
  switch (input.tool) {
    case "read":
      return readHostFile(input);
    case "ls":
      return listHostDirectory(input);
    case "find":
      return findHostFiles(input);
    case "grep":
      return grepHostFiles(input);
    default:
      return errorResult("PI_TOOL_UNSUPPORTED", "PI_TOOL_UNSUPPORTED");
  }
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

async function readHostFile(input: HostReadOnlyToolInput): Promise<HostReadOnlyToolResult> {
  const rawPath = typeof input.parameters["path"] === "string" ? input.parameters["path"] : "";
  const offset = optionalPositiveInteger(input.parameters["offset"]);
  const limit = optionalPositiveInteger(input.parameters["limit"]);
  if (input.parameters["offset"] !== undefined && offset === undefined)
    return errorResult("PI_TOOL_ARGUMENTS_INVALID", "PI_TOOL_ARGUMENTS_INVALID");
  if (input.parameters["limit"] !== undefined && limit === undefined)
    return errorResult("PI_TOOL_ARGUMENTS_INVALID", "PI_TOOL_ARGUMENTS_INVALID");
  if (protectedComponents(input.relativePath))
    return errorResult("PI_PROTECTED_PATH", "PI_PROTECTED_PATH");
  const kind = await input.port.inspectEntry({
    grant: input.grant,
    relativePath: input.relativePath,
  });
  if (kind === null) return errorResult("PI_FILE_MISSING", "PI_FILE_MISSING");
  if (kind !== "file") return errorResult("CODING_PATH_IS_DIRECTORY", DIRECTORY_READ_MESSAGE);
  let bytes: Uint8Array;
  try {
    bytes = await input.port.readFile({
      grant: input.grant,
      relativePath: input.relativePath,
      maximumBytes: input.readBytesLimit,
    });
  } catch (error) {
    const known = knownError(error);
    if (known?.code === HOST_READ_ONLY_ERROR_CODES.PROTECTED)
      return errorResult("PI_PROTECTED_PATH", "PI_PROTECTED_PATH");
    if (known?.code === HOST_READ_ONLY_ERROR_CODES.TARGET_MISSING)
      return errorResult("PI_FILE_MISSING", "PI_FILE_MISSING");
    return errorResult(
      known?.code ?? "PI_READ_FAILED",
      known?.code ?? `PI_READ_FAILED: ${rawPath}`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return errorResult("PI_TEXT_READ_REJECTED", "PI_TEXT_READ_REJECTED");
  }
  if (text.includes("\0")) return errorResult("PI_TEXT_READ_REJECTED", "PI_TEXT_READ_REJECTED");
  try {
    assertMachineSecretFree(text);
  } catch {
    return errorResult("PI_TEXT_READ_REJECTED", "PI_TEXT_READ_REJECTED");
  }
  const allLines = text.split("\n");
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;
  if (startLine >= allLines.length)
    return errorResult(
      "PI_READ_OFFSET_OUT_OF_RANGE",
      `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
    );
  let selectedContent: string;
  let userLimitedLines: number | undefined;
  if (limit !== undefined) {
    const endLine = Math.min(startLine + limit, allLines.length);
    selectedContent = allLines.slice(startLine, endLine).join("\n");
    userLimitedLines = endLine - startLine;
  } else {
    selectedContent = allLines.slice(startLine).join("\n");
  }
  const truncation = truncateHead(selectedContent);
  let outputText: string;
  let details: unknown;
  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf-8"));
    outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${rawPath} | head -c ${DEFAULT_MAX_BYTES}]`;
    details = { truncation };
  } else if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    outputText = truncation.content;
    if (truncation.truncatedBy === "lines") {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length}. Use offset=${nextOffset} to continue.]`;
    } else {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    }
    details = { truncation };
  } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
    const remaining = allLines.length - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  } else {
    outputText = truncation.content;
  }
  return { content: outputText, isError: false, errorCode: null, details };
}

function relativeToGrant(input: HostReadOnlyToolInput, absolute: string): string {
  const root = input.grant.displayPath.replace(/\/+$/, "") || "/";
  const relative = path.relative(root, absolute);
  if (relative === "" || relative === ".") return "";
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("PI_PATH_OUTSIDE_SCOPE");
  return relative.split(path.sep).join("/");
}

function lsOperations(input: HostReadOnlyToolInput) {
  return {
    exists: async (absolute: string) => {
      const relative = relativeToGrant(input, absolute);
      if (protectedComponents(relative)) return true;
      const entry = await input.port.inspectEntry({ grant: input.grant, relativePath: relative });
      return entry !== null;
    },
    stat: async (absolute: string) => {
      const relative = relativeToGrant(input, absolute);
      if (protectedComponents(relative)) {
        const parts = relative.split("/");
        const kind = await entryKind(
          input,
          parts.slice(0, -1).join("/"),
          parts[parts.length - 1] ?? "",
        );
        return { isDirectory: () => kind === "directory" };
      }
      const kind = await input.port.inspectEntry({ grant: input.grant, relativePath: relative });
      if (kind === null) throw new Error("PI_FILE_MISSING");
      return { isDirectory: () => kind === "directory" };
    },
    readdir: async (absolute: string) => {
      const relative = relativeToGrant(input, absolute);
      const entries = await input.port.listDirectory({
        grant: input.grant,
        relativePath: relative,
      });
      return entries.map((entry) => entry.name);
    },
  };
}

async function entryKind(
  input: HostReadOnlyToolInput,
  parent: string,
  name: string,
): Promise<HostReadOnlyEntryKind> {
  try {
    const entries = await input.port.listDirectory({ grant: input.grant, relativePath: parent });
    return entries.find((entry) => entry.name === name)?.kind ?? "other";
  } catch {
    return "other";
  }
}

interface ReusableDefinition {
  execute(
    toolCallId: string,
    parameters: never,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: never,
  ): Promise<{ content: { type: string; text?: string }[]; details?: unknown }>;
}

async function runReusedDefinition(
  definition: ReusableDefinition,
  input: HostReadOnlyToolInput,
): Promise<HostReadOnlyToolResult> {
  try {
    const result = await definition.execute(
      input.toolCallId,
      input.parameters as never,
      input.signal,
      undefined,
      {} as never,
    );
    const text = result.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    return { content: text, isError: false, errorCode: null, details: result.details };
  } catch (error) {
    const known = knownError(error);
    return errorResult(
      known?.code ?? "PI_TOOL_FAILED",
      error instanceof Error ? error.message : "PI_TOOL_FAILED",
    );
  }
}

async function listHostDirectory(input: HostReadOnlyToolInput): Promise<HostReadOnlyToolResult> {
  if (protectedComponents(input.relativePath)) {
    const parts = input.relativePath.split("/");
    const name = parts[parts.length - 1] ?? "";
    const kind = await entryKind(input, parts.slice(0, -1).join("/"), name);
    if (kind === "directory")
      return { content: "(empty directory)", isError: false, errorCode: null };
    return errorResult(
      "PI_TOOL_FAILED",
      `Not a directory: ${input.grant.displayPath}/${input.relativePath}`,
    );
  }
  return runReusedDefinition(
    createLsToolDefinition(input.grant.displayPath, {
      operations: lsOperations(input),
    }) as unknown as ReusableDefinition,
    input,
  );
}

async function findHostFiles(input: HostReadOnlyToolInput): Promise<HostReadOnlyToolResult> {
  if (protectedComponents(input.relativePath))
    return { content: "No files found matching pattern", isError: false, errorCode: null };
  const operations = lsOperations(input);
  return runReusedDefinition(
    createFindToolDefinition(input.grant.displayPath, {
      operations: {
        exists: operations.exists,
        glob: async (pattern: string, cwd: string, options: { limit: number }) => {
          const searchRelative = relativeToGrant(input, cwd);
          return globHostTree(input, searchRelative, pattern, options.limit);
        },
      },
    }) as unknown as ReusableDefinition,
    input,
  );
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface WalkEntry {
  readonly relative: string;
  readonly name: string;
  readonly kind: HostReadOnlyEntryKind;
}

async function* walkHostTree(
  input: HostReadOnlyToolInput,
  root: string,
  patterns: readonly string[],
): AsyncGenerator<WalkEntry> {
  const matcher = buildMatcher(patterns);
  const entries = await input.port.listDirectory({ grant: input.grant, relativePath: root });
  for (const entry of [...entries].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    input.signal?.throwIfAborted();
    const relative = root === "" ? entry.name : `${root}/${entry.name}`;
    if (ALWAYS_SKIPPED_NAMES.has(entry.name)) continue;
    const protectedEntry = firstProtectedDirectoryEntry(relative.split("/")) !== undefined;
    if (!protectedEntry && matcher.ignores(relative)) continue;
    yield { relative, name: entry.name, kind: entry.kind };
    await yieldToEventLoop();
    if (!protectedEntry && entry.kind === "directory") {
      const nested = [...patterns, ...(await ignorePatternsFor(input, relative))];
      yield* walkHostTree(input, relative, nested);
    }
  }
}

function buildMatcher(patterns: readonly string[]): ReturnType<typeof ignore> {
  const matcher = ignore();
  if (patterns.length > 0) matcher.add([...patterns]);
  return matcher;
}

async function ignorePatternsFor(
  input: HostReadOnlyToolInput,
  directory: string,
): Promise<readonly string[]> {
  const collected: string[] = [];
  for (const filename of IGNORE_FILE_NAMES) {
    const relative = directory === "" ? filename : `${directory}/${filename}`;
    let bytes: Uint8Array;
    try {
      bytes = await input.port.readFile({
        grant: input.grant,
        relativePath: relative,
        maximumBytes: IGNORE_FILE_BYTES,
      });
    } catch {
      continue;
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      continue;
    }
    const prefix = directory === "" ? "" : `${directory}/`;
    for (const line of content.split(/\r?\n/)) {
      const pattern = prefixIgnorePattern(line, prefix);
      if (pattern !== null) collected.push(pattern);
    }
  }
  return collected;
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

function matchesGlob(relative: string, name: string, pattern: string): boolean {
  if (pattern.includes("/")) {
    const prefixed =
      pattern.startsWith("/") || pattern.startsWith("**/") || pattern === "**"
        ? pattern.replace(/^\//, "")
        : `**/${pattern}`;
    return path.matchesGlob(relative, prefixed);
  }
  return path.matchesGlob(name, pattern);
}

async function globHostTree(
  input: HostReadOnlyToolInput,
  root: string,
  pattern: string,
  limit: number,
): Promise<string[]> {
  const results: string[] = [];
  const patterns = await ignorePatternsFor(input, root);
  for await (const entry of walkHostTree(input, root, patterns)) {
    if (entry.kind === "directory" && ALWAYS_SKIPPED_NAMES.has(entry.name)) continue;
    if (matchesGlob(entry.relative, entry.name, pattern)) {
      results.push(entry.relative);
      if (results.length >= limit) break;
    }
  }
  return results;
}

const POSIX_CLASS = /\[\[:[a-z]+:\]\]/;
const INLINE_FLAG = /\(\?[imsxu-]+[:)]|\(\?P[<=]/;

async function grepHostFiles(input: HostReadOnlyToolInput): Promise<HostReadOnlyToolResult> {
  const rawPattern = input.parameters["pattern"];
  if (typeof rawPattern !== "string" || rawPattern.length === 0)
    return errorResult("PI_TOOL_ARGUMENTS_INVALID", "PI_TOOL_ARGUMENTS_INVALID");
  const ignoreCase = input.parameters["ignoreCase"] === true;
  const literal = input.parameters["literal"] === true;
  const glob = typeof input.parameters["glob"] === "string" ? input.parameters["glob"] : undefined;
  const context =
    typeof input.parameters["context"] === "number" && input.parameters["context"] > 0
      ? input.parameters["context"]
      : 0;
  const limit = Math.max(
    1,
    typeof input.parameters["limit"] === "number" ? input.parameters["limit"] : 100,
  );
  if (POSIX_CLASS.test(rawPattern) || INLINE_FLAG.test(rawPattern))
    return errorResult(
      "GREP_PATTERN_UNSUPPORTED",
      "GREP_PATTERN_UNSUPPORTED: ripgrep-only syntax such as inline flags (?i) or POSIX classes [[:alpha:]] is not supported; rewrite the pattern.",
    );
  let expression: RegExp;
  try {
    const source = literal ? rawPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : rawPattern;
    expression = new RegExp(source, ignoreCase ? "gi" : "g");
  } catch (error) {
    return errorResult(
      "GREP_PATTERN_UNSUPPORTED",
      `GREP_PATTERN_UNSUPPORTED: ${error instanceof Error ? error.message : "invalid pattern"}`,
    );
  }
  const searchRoot = input.relativePath;
  if (protectedComponents(searchRoot))
    return { content: "No matches found", isError: false, errorCode: null };
  let searchIsDirectory = true;
  if (searchRoot !== "") {
    const kind = await input.port.inspectEntry({ grant: input.grant, relativePath: searchRoot });
    if (kind === null) return errorResult("PI_FILE_MISSING", `Path not found: ${searchRoot}`);
    searchIsDirectory = kind === "directory";
  }
  const candidates: WalkEntry[] = [];
  if (searchIsDirectory) {
    const patterns = await ignorePatternsFor(input, searchRoot);
    for await (const entry of walkHostTree(input, searchRoot, patterns)) {
      if (entry.kind !== "file") continue;
      if (glob !== undefined && !matchesGlob(entry.relative, entry.name, glob)) continue;
      candidates.push(entry);
    }
  } else {
    candidates.push({ relative: searchRoot, name: path.basename(searchRoot), kind: "file" });
  }
  const formatPath = (entry: WalkEntry): string => {
    if (!searchIsDirectory) return path.basename(entry.relative);
    if (searchRoot === "") return entry.relative;
    return entry.relative.startsWith(`${searchRoot}/`)
      ? entry.relative.slice(searchRoot.length + 1)
      : entry.relative;
  };
  const outputLines: string[] = [];
  let matchCount = 0;
  let matchLimitReached = false;
  let linesTruncated = false;
  let skippedFiles = 0;
  for (const entry of candidates) {
    if (matchCount >= limit) {
      matchLimitReached = true;
      break;
    }
    if (firstProtectedDirectoryEntry(entry.relative.split("/")) !== undefined) continue;
    let bytes: Uint8Array;
    try {
      bytes = await input.port.readFile({
        grant: input.grant,
        relativePath: entry.relative,
        maximumBytes: input.readBytesLimit,
      });
    } catch {
      skippedFiles += 1;
      continue;
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      skippedFiles += 1;
      continue;
    }
    if (content.includes("\0")) continue;
    input.signal?.throwIfAborted();
    await yieldToEventLoop();
    const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const formatted = formatPath(entry);
    const contextValue = context > 0 ? context : 0;
    for (let index = 0; index < lines.length; index++) {
      if (matchCount >= limit) {
        matchLimitReached = true;
        break;
      }
      const line = lines[index] ?? "";
      expression.lastIndex = 0;
      if (!expression.test(line)) continue;
      matchCount += 1;
      if (contextValue === 0) {
        const { text, wasTruncated } = truncateLine(line.replace(/\n$/, ""));
        if (wasTruncated) linesTruncated = true;
        outputLines.push(`${formatted}:${index + 1}: ${text}`);
      } else {
        const start = Math.max(1, index + 1 - contextValue);
        const end = Math.min(lines.length, index + 1 + contextValue);
        for (let current = start; current <= end; current++) {
          const lineText = (lines[current - 1] ?? "").replace(/\r/g, "");
          const { text, wasTruncated } = truncateLine(lineText);
          if (wasTruncated) linesTruncated = true;
          if (current === index + 1) outputLines.push(`${formatted}:${current}: ${text}`);
          else outputLines.push(`${formatted}-${current}- ${text}`);
        }
      }
      if (matchCount >= limit) {
        matchLimitReached = true;
        break;
      }
    }
  }
  if (matchCount === 0)
    return {
      content:
        skippedFiles > 0
          ? `No matches found\n\n[${skippedFiles} 个文件因过大或无法读取未搜索]`
          : "No matches found",
      isError: false,
      errorCode: null,
    };
  const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  let output = truncation.content;
  const notices: string[] = [];
  if (matchLimitReached)
    notices.push(
      `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`,
    );
  if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  if (linesTruncated)
    notices.push(
      `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
    );
  if (skippedFiles > 0) notices.push(`${skippedFiles} 个文件因过大或无法读取未搜索`);
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
  return { content: output, isError: false, errorCode: null };
}
