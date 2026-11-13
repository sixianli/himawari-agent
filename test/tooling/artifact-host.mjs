import { afterAll, beforeAll } from "vitest";
import { hostPlatform } from "../../scripts/ci/platforms.mjs";

export function useArtifactCapableHost() {
  const original = {};
  beforeAll(() => {
    if (hostPlatform() !== "linux-arm64") return;
    for (const [key, value] of [
      ["platform", "linux"],
      ["arch", "x64"],
    ]) {
      original[key] = Object.getOwnPropertyDescriptor(process, key);
      Object.defineProperty(process, key, { value, configurable: true, enumerable: true });
    }
  });
  afterAll(() => {
    for (const [key, descriptor] of Object.entries(original))
      Object.defineProperty(process, key, descriptor);
  });
}
