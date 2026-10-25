export interface TemporaryCredentialRequest {
  readonly credentialId: string;
  readonly secretRef: string;
  readonly approvalRef: string;
  readonly expiresAt: string;
}

export interface TemporaryCredentialIssuer {
  issue(request: TemporaryCredentialRequest): Promise<{
    readonly environment: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  }>;
  revoke(credentialId: string): Promise<void>;
  isRevoked(credentialId: string): Promise<boolean>;
}

export interface TemporaryCredentialRecord {
  readonly credentialId: string;
  readonly invocationId: string;
  readonly secretRef: string;
  readonly approvalRef: string;
  readonly expiresAt: string;
}

const MAX_VARIABLES = 16;
const MAX_VALUE_LENGTH = 16 * 1024;

export function credentialEnvironment(
  issued: { readonly environment: Readonly<Record<string, string>>; readonly expiresAt: string },
  requestedExpiresAt: string,
  reservedNames: readonly string[],
): Readonly<Record<string, string>> | null {
  const reserved = new Set(reservedNames.map((name) => name.toUpperCase()));
  const entries = Object.entries(issued.environment);
  const issuedExpiry = Date.parse(issued.expiresAt);
  if (
    !Number.isFinite(issuedExpiry) ||
    issuedExpiry > Date.parse(requestedExpiresAt) ||
    entries.length === 0 ||
    entries.length > MAX_VARIABLES
  )
    return null;
  const valid = entries.every(
    ([name, value]) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !reserved.has(name.toUpperCase()) &&
      !name.toUpperCase().startsWith("DOCKER_") &&
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_VALUE_LENGTH &&
      !value.includes("\0"),
  );
  return valid ? Object.fromEntries(entries) : null;
}
