export const persistenceSqliteWorkspace = {
  adapterKind: "persistence",
  authority: "sqlite",
} as const;

export * from "./migration-engine.js";
export * from "./durable-adapters.js";
export * from "./product-state-repository.js";
export * from "./schema-catalog.js";
export * from "./sqlite-authority-transfer.js";
export * from "./sqlite-governed-deletion.js";
export * from "./sqlite-recovery-point.js";
export * from "./state-root-lock.js";
