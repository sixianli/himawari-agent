import { DOMAIN_ERROR_CODES, DomainError } from "./errors.js";

declare const identifierBrand: unique symbol;

type Identifier<Kind extends string> = string & {
  readonly [identifierBrand]: Kind;
};

export type OwnerId = Identifier<"OwnerId">;
export type AgentId = Identifier<"AgentId">;
export type ThreadId = Identifier<"ThreadId">;
export type SessionId = Identifier<"SessionId">;
export type RunId = Identifier<"RunId">;
export type TurnId = Identifier<"TurnId">;
export type TriggerId = Identifier<"TriggerId">;
export type IdempotencyKey = Identifier<"IdempotencyKey">;
export type AuthorityLeaseId = Identifier<"AuthorityLeaseId">;
export type AuthorityHolderId = Identifier<"AuthorityHolderId">;

const MACHINE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function createIdentifier<Kind extends string>(value: string, kind: Kind): Identifier<Kind> {
  if (!MACHINE_IDENTIFIER_PATTERN.test(value)) {
    throw new DomainError(
      DOMAIN_ERROR_CODES.INVALID_IDENTIFIER,
      `${kind} must be a 1-128 character machine identifier`,
      { kind, value },
    );
  }

  return value as Identifier<Kind>;
}

export function createOwnerId(value: string): OwnerId {
  return createIdentifier(value, "OwnerId");
}

export function createAgentId(value: string): AgentId {
  return createIdentifier(value, "AgentId");
}

export function createThreadId(value: string): ThreadId {
  return createIdentifier(value, "ThreadId");
}

export function createSessionId(value: string): SessionId {
  return createIdentifier(value, "SessionId");
}

export function createRunId(value: string): RunId {
  return createIdentifier(value, "RunId");
}

export function createTurnId(value: string): TurnId {
  return createIdentifier(value, "TurnId");
}

export function createTriggerId(value: string): TriggerId {
  return createIdentifier(value, "TriggerId");
}

export function createIdempotencyKey(value: string): IdempotencyKey {
  return createIdentifier(value, "IdempotencyKey");
}

export function createAuthorityLeaseId(value: string): AuthorityLeaseId {
  return createIdentifier(value, "AuthorityLeaseId");
}

export function createAuthorityHolderId(value: string): AuthorityHolderId {
  return createIdentifier(value, "AuthorityHolderId");
}
