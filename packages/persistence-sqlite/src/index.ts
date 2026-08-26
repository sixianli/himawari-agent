export const persistenceSqliteWorkspace = {
  adapterKind: "persistence",
  authority: "sqlite",
} as const;

export * from "./migration-engine.js";
export * from "./schema-catalog.js";
