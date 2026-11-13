const realHost = { os: process.platform, arch: process.arch };
const defaultHost =
  realHost.os === "linux" && realHost.arch === "arm64" ? { os: "linux", arch: "x64" } : realHost;
let simulatedHost;

const currentHost = () => simulatedHost ?? defaultHost;

export async function withHost(os, arch, action) {
  const previous = simulatedHost;
  simulatedHost = { os, arch };
  try {
    return await action();
  } finally {
    simulatedHost = previous;
  }
}

export function artifactCapablePlatforms(original) {
  return {
    ...original,
    hostOs: () => currentHost().os,
    hostArch: () => currentHost().arch,
    hostPlatform: () => `${currentHost().os}-${currentHost().arch}`,
    artifactPlatformKey: (os = currentHost().os, arch = currentHost().arch) =>
      original.artifactPlatformKey(os, arch),
    buildPlatformKey: (os = currentHost().os, arch = currentHost().arch) =>
      original.buildPlatformKey(os, arch),
  };
}
