export const DOMAIN_ERROR_CODES = Object.freeze({
  INVALID_IDENTIFIER: "DOMAIN_INVALID_IDENTIFIER",
  OWNERSHIP_MISMATCH: "DOMAIN_OWNERSHIP_MISMATCH",
  INVALID_RUN_TRANSITION: "DOMAIN_INVALID_RUN_TRANSITION",
  RUN_ALREADY_TERMINAL: "DOMAIN_RUN_ALREADY_TERMINAL",
  AUTHORITY_LEASE_CONFLICT: "DOMAIN_AUTHORITY_LEASE_CONFLICT",
  AUTHORITY_LEASE_NOT_HELD: "DOMAIN_AUTHORITY_LEASE_NOT_HELD",
  AUTHORITY_LEASE_SCOPE_MISMATCH: "DOMAIN_AUTHORITY_LEASE_SCOPE_MISMATCH",
} as const);

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[keyof typeof DOMAIN_ERROR_CODES];

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
