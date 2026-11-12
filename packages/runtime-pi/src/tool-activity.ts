import {
  CHAT_PROCESS_ICONS_SECTION,
  TOOL_ACTIVITY_ICON_PARAMETER,
  TOOL_ACTIVITY_ICON_PARAMETER_NAME,
  TOOL_ACTIVITY_PARAMETER,
  TOOL_ACTIVITY_PARAMETER_NAME,
} from "@himawari-agent/prompt-catalog";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function withToolActivityParameters<Parameters>(parameters: Parameters): Parameters {
  if (!isRecord(parameters) || parameters["type"] !== "object") return parameters;
  const properties = parameters["properties"] ?? {};
  if (
    !isRecord(properties) ||
    TOOL_ACTIVITY_PARAMETER_NAME in properties ||
    TOOL_ACTIVITY_ICON_PARAMETER_NAME in properties
  )
    return parameters;
  return {
    ...parameters,
    properties: {
      ...properties,
      [TOOL_ACTIVITY_PARAMETER_NAME]: {
        type: "string",
        description: TOOL_ACTIVITY_PARAMETER.text,
      },
      [TOOL_ACTIVITY_ICON_PARAMETER_NAME]: {
        type: "string",
        description: TOOL_ACTIVITY_ICON_PARAMETER.text,
      },
    },
  } as Parameters;
}

export function carriesToolActivity(parameters: unknown): boolean {
  if (!isRecord(parameters) || !isRecord(parameters["properties"])) return false;
  const activity = parameters["properties"][TOOL_ACTIVITY_PARAMETER_NAME];
  return isRecord(activity) && activity["description"] === TOOL_ACTIVITY_PARAMETER.text;
}

export function removeToolActivity(input: Record<string, unknown>): void {
  delete input[TOOL_ACTIVITY_PARAMETER_NAME];
  delete input[TOOL_ACTIVITY_ICON_PARAMETER_NAME];
}

export function processIconsSection(tools: readonly { readonly parameters: unknown }[]): string[] {
  return tools.some(({ parameters }) => carriesToolActivity(parameters))
    ? [CHAT_PROCESS_ICONS_SECTION.text]
    : [];
}
