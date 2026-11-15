export const OPTIONAL_TOOLCHAIN_PATHS: readonly string[];

export function resolveReadOnlyToolchainPaths(
  entries: readonly string[],
  options?: {
    readonly optional?: readonly string[];
    readonly dedupe?: boolean;
    readonly io?: {
      readonly lstat: (path: string) => Promise<unknown>;
      readonly realpath: (path: string) => Promise<string>;
    };
  },
): Promise<string[]>;
