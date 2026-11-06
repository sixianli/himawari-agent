import {
  createBashToolDefinition,
  createEditToolDefinition,
  createGrepToolDefinition,
  createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  TOOL_BUILTIN_BASH,
  TOOL_BUILTIN_BASH_TIMEOUT,
  TOOL_BUILTIN_READ,
  TOOL_BUILTIN_READ_GUIDELINE,
  TOOL_BUILTIN_READONLY_SUFFIX,
  TOOL_BUILTIN_WRITE_SUFFIX,
} from "@himawari-agent/prompt-catalog";
import { describe, expect, it } from "vitest";
import { himawariBuiltinToolText } from "../src/pi-builtin-tool-text.js";

const PI_ORIGINAL_TEXT = {
  readDescription:
    "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
  readGuidelines: ["Use read to examine files instead of cat or sed."],
  bashDescription:
    "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
  bashTimeout: "Timeout in seconds (optional, no default timeout)",
  bashGuidelines: [
    "You can inspect PI_* environment variables for current model and session details.",
  ],
};

function piOriginalText() {
  const read = createReadToolDefinition("/workspace");
  const bash = createBashToolDefinition("/workspace");
  const timeout = (bash.parameters as { properties: Record<string, { description?: string }> })
    .properties["timeout"];
  return {
    readDescription: read.description,
    readGuidelines: read.promptGuidelines,
    bashDescription: bash.description,
    bashTimeout: timeout?.description,
    bashGuidelines: bash.promptGuidelines,
  };
}

function piTextDrift(current: Record<string, unknown>): string[] {
  return Object.keys(PI_ORIGINAL_TEXT).filter(
    (key) =>
      JSON.stringify(current[key]) !==
      JSON.stringify(PI_ORIGINAL_TEXT[key as keyof typeof PI_ORIGINAL_TEXT]),
  );
}

function contradictions(text: {
  readonly description: string;
  readonly guidelines: readonly string[];
  readonly timeout?: string | undefined;
}): string[] {
  const all = [text.description, ...text.guidelines, text.timeout ?? ""].join("\n");
  return [
    "Supports text files and images",
    "Images are sent as attachments",
    "full output is saved to a temp file",
    "no default timeout",
    "instead of cat",
    "PI_* environment variables",
  ].filter((phrase) => all.includes(phrase));
}

describe("[PROMPT-PI-TEXT] Himawari replaces only the Pi built-in tool text that contradicts it (ADR 0166)", () => {
  it("C10: the Pi text we replace is still the Pi 0.84.2 original; a Pi upgrade that changes it fails here", () => {
    expect(piTextDrift(piOriginalText())).toEqual([]);
  });

  it("C6 W-02, W-03, W-04, W-25: the read and bash text the model sees comes from the catalog", () => {
    const read = himawariBuiltinToolText(createReadToolDefinition("/workspace"));
    expect(read.description).toBe(TOOL_BUILTIN_READ.text);
    expect(read.promptGuidelines).toEqual([TOOL_BUILTIN_READ_GUIDELINE.text]);
    const bash = himawariBuiltinToolText(createBashToolDefinition("/workspace"));
    expect(bash.description).toBe(TOOL_BUILTIN_BASH.text);
    expect(bash.promptGuidelines).toBeUndefined();
    const properties = (bash.parameters as { properties: Record<string, { description?: string }> })
      .properties;
    expect(properties["timeout"]?.description).toBe(TOOL_BUILTIN_BASH_TIMEOUT.text);
    expect(properties["command"]?.description).toBe("Bash command to execute");
    expect(
      contradictions({
        description: `${read.description}\n${bash.description}`,
        guidelines: [...(read.promptGuidelines ?? []), ...(bash.promptGuidelines ?? [])],
        timeout: properties["timeout"]?.description,
      }),
    ).toEqual([]);
  });

  it("keeps the Pi text that is right and appends the Himawari boundary", () => {
    const grep = createGrepToolDefinition("/workspace");
    expect(himawariBuiltinToolText(grep)).toMatchObject({
      description: `${grep.description}\n${TOOL_BUILTIN_READONLY_SUFFIX.text}`,
      parameters: grep.parameters,
    });
    const edit = createEditToolDefinition("/workspace");
    expect(himawariBuiltinToolText(edit)).toMatchObject({
      description: `${edit.description}\n${TOOL_BUILTIN_WRITE_SUFFIX.text}`,
      promptGuidelines: edit.promptGuidelines,
    });
  });

  it("C6 REVERSE: the Pi originals contradict Himawari and are reported", () => {
    expect(
      contradictions({
        description: `${PI_ORIGINAL_TEXT.readDescription}\n${PI_ORIGINAL_TEXT.bashDescription}`,
        guidelines: [...PI_ORIGINAL_TEXT.readGuidelines, ...PI_ORIGINAL_TEXT.bashGuidelines],
        timeout: PI_ORIGINAL_TEXT.bashTimeout,
      }),
    ).toEqual([
      "Supports text files and images",
      "Images are sent as attachments",
      "full output is saved to a temp file",
      "no default timeout",
      "instead of cat",
      "PI_* environment variables",
    ]);
  });

  it("C10 REVERSE: a changed Pi original is reported", () => {
    expect(
      piTextDrift({ ...piOriginalText(), readGuidelines: ["Use read to examine files."] }),
    ).toEqual(["readGuidelines"]);
    expect(
      piTextDrift({ ...piOriginalText(), bashTimeout: "Timeout in seconds (default 120)" }),
    ).toEqual(["bashTimeout"]);
  });
});
