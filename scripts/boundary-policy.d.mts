export const allowedInternalDependencies: ReadonlyMap<string, ReadonlySet<string>>;
export const nodeImportAllowedPackages: ReadonlySet<string>;
export const browserOnlyPackages: ReadonlySet<string>;
export const browserExternalPackages: ReadonlySet<string>;
export const piDependencyOwner: string;

export function packageSpecifier(specifier: string): string;
export function isExactExternalVersion(version: string): boolean;
export function isInternalDependencyAllowed(packageName: string, dependency: string): boolean;
export function isNodeImportAllowed(packageName: string): boolean;
export function isBrowserImportAllowed(
  packageName: string,
  specifier: string,
  workspaceNames: ReadonlySet<string>,
): boolean;
