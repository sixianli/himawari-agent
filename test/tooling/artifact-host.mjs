const artifactHost = { os: "linux", arch: "x64" };

export function artifactCapablePlatforms(original) {
  if (original.hostPlatform() !== "linux-arm64") return original;
  return {
    ...original,
    hostOs: () => artifactHost.os,
    hostArch: () => artifactHost.arch,
    hostPlatform: () => `${artifactHost.os}-${artifactHost.arch}`,
    artifactPlatformKey: (os = artifactHost.os, arch = artifactHost.arch) =>
      original.artifactPlatformKey(os, arch),
    buildPlatformKey: (os = artifactHost.os, arch = artifactHost.arch) =>
      original.buildPlatformKey(os, arch),
  };
}
