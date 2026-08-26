export const controlCenterWorkspace = {
  applicationKind: "browser-control-center",
  browserOnly: true,
} as const;

export * from "./browser-storage.js";
export * from "./gateway-client.js";
export * from "./messages.js";
export * from "./sse-synchronizer.js";
