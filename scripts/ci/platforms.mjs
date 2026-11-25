const BUILD_PLATFORM_KEYS = Object.freeze({
  "darwin-arm64": "macos-arm64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
});

export const hostOs = () => process.platform;

export const hostArch = () => process.arch;

export const hostPlatform = () => `${hostOs()}-${hostArch()}`;

export const supportedPlatforms = () => Object.keys(BUILD_PLATFORM_KEYS);

const ARTIFACT_PLATFORM_KEYS = Object.freeze(["macos-arm64", "linux-x64"]);

export function artifactPlatformKey(os = hostOs(), arch = hostArch()) {
  const key = buildPlatformKey(os, arch);
  if (!ARTIFACT_PLATFORM_KEYS.includes(key))
    throw new Error(`CI_ARTIFACT_PLATFORM_UNSUPPORTED: ${key}`);
  return key;
}

export function buildPlatformKey(os = hostOs(), arch = hostArch()) {
  const platform = `${os}-${arch}`;
  if (!Object.hasOwn(BUILD_PLATFORM_KEYS, platform))
    throw new Error(`CI_PLATFORM_UNSUPPORTED: ${platform}`);
  return BUILD_PLATFORM_KEYS[platform];
}
