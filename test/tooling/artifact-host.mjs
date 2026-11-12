import { afterAll, beforeAll } from "vitest";
import { hostPlatform } from "../../scripts/ci/platforms.mjs";

const ARTIFACT_HOSTS = ["darwin-arm64", "linux-x64"];

export function useArtifactCapableHost() {
  const original = {};
  beforeAll(() => {
    if (ARTIFACT_HOSTS.includes(hostPlatform())) return;
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
