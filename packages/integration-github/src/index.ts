export const integrationGitHubWorkspace = {
  adapterKind: "external-event",
  provider: "github-app",
} as const;

export * from "./app-credentials.js";
export * from "./monitor-control.js";
export * from "./read-only.js";
export * from "./webhook.js";
