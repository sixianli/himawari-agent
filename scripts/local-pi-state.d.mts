export interface LocalPiArtifactStatus {
  readonly path: string;
  readonly present: boolean;
}

export interface LocalPiInspection {
  readonly packageName: string;
  readonly expectedVersion: string;
  readonly localVersion: string;
  readonly localRoot: string;
  readonly localPackage: string;
  readonly installedPackage: string;
  readonly installedRealPath: string | null;
  readonly mode: "local" | "published";
  readonly ready: boolean;
  readonly artifacts: readonly LocalPiArtifactStatus[];
}

export function inspectLocalPi(root?: string): Promise<LocalPiInspection>;
export function linkLocalPi(root?: string): Promise<LocalPiInspection>;
export function unlinkLocalPi(root?: string): Promise<LocalPiInspection>;
