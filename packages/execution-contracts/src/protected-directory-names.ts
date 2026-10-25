export const PROTECTED_DIRECTORY_NAMES: readonly string[] = Object.freeze([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".ssh",
  ".aws",
  ".himawari-trash",
  ".himawari-recovery",
]);

export const PROTECTED_DIRECTORY_PREFIXES: readonly string[] = Object.freeze([
  ".env.",
  "id_rsa",
  "id_ed25519",
]);

export const PROTECTED_DIRECTORY_SUFFIXES: readonly string[] = Object.freeze([".pem", ".key"]);

export const PROTECTED_DIRECTORY_PATH = ".docker/config.json";

export const REJECTED_PATH_COMPONENT_PREFIX = ".himawari-";

export function isRejectedPathComponent(name: string): boolean {
  return name === ".git" || name === ".env" || name.startsWith(REJECTED_PATH_COMPONENT_PREFIX);
}

export function firstRejectedPathComponent(components: readonly string[]): string | undefined {
  return components.find((name) => isRejectedPathComponent(name));
}

const NAMES = new Set(PROTECTED_DIRECTORY_NAMES);

export function isProtectedDirectoryName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    NAMES.has(lower) ||
    PROTECTED_DIRECTORY_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    PROTECTED_DIRECTORY_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  );
}

export function isProtectedDirectoryEntry(relativePath: string, name: string): boolean {
  if (isProtectedDirectoryName(name)) return true;
  const lowerPath = relativePath.toLowerCase();
  return (
    lowerPath === PROTECTED_DIRECTORY_PATH || lowerPath.endsWith(`/${PROTECTED_DIRECTORY_PATH}`)
  );
}

export function firstProtectedDirectoryEntry(components: readonly string[]): string | undefined {
  for (let index = 0; index < components.length; index++) {
    const name = components[index];
    if (
      name !== undefined &&
      isProtectedDirectoryEntry(components.slice(0, index + 1).join("/"), name)
    )
      return name;
  }
  return undefined;
}
