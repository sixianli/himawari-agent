const BUILD_PLATFORM_KEYS = Object.freeze({
  "darwin-arm64": "macos-arm64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
});

export const hostPlatform = () => `${process.platform}-${process.arch}`;

export const supportedPlatforms = () => Object.keys(BUILD_PLATFORM_KEYS);

export function buildPlatformKey(os = process.platform, arch = process.arch) {
  const platform = `${os}-${arch}`;
  if (!Object.hasOwn(BUILD_PLATFORM_KEYS, platform))
    throw new Error(`CI_PLATFORM_UNSUPPORTED: ${platform}`);
  return BUILD_PLATFORM_KEYS[platform];
}
