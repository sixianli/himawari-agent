export interface BuildInfo {
  readonly revision: string;
  readonly date: string;
}

export function resolveBuildInfo(
  environment: Readonly<Record<string, string | undefined>>,
): BuildInfo | null;
