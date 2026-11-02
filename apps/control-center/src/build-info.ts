export interface BuildInfo {
  readonly revision: string;
  readonly date: string;
}

export function readBuildInfo(): BuildInfo | null {
  return typeof __HIMAWARI_BUILD__ === "undefined" ? null : __HIMAWARI_BUILD__;
}
