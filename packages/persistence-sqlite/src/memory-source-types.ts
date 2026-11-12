import type { MemorySourceType } from "@himawari-agent/application";

export const KNOWN_MEMORY_SOURCE_TYPES: Readonly<Record<MemorySourceType, true>> = Object.freeze({
  reference: true,
  perception: true,
});
export const PERCEPTION_MEMORY_SOURCE_ID = /^perception:[A-Za-z0-9_-]{16,64}$/u;

export function isKnownMemorySourceType(value: string): value is MemorySourceType {
  return Object.hasOwn(KNOWN_MEMORY_SOURCE_TYPES, value);
}
