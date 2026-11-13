import { createHash } from "node:crypto";
import { createAgentId, createDeploymentId, createOwnerId } from "@himawari-agent/domain";
import { machineString } from "@himawari-agent/gateway-contracts";

export const TENANT_SLUG_MAXIMUM_LENGTH = 32;
export const TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const TENANT_KINDS = ["owner", "member", "trial"] as const;
export const TENANT_STATUSES = [
  "invited",
  "provisioning",
  "active",
  "maintenance",
  "suspended",
  "failed",
] as const;

export type TenantKind = (typeof TENANT_KINDS)[number];
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const TENANT_IDENTITY_ERROR_CODES = Object.freeze({
  SLUG_INVALID: "TENANT_SLUG_INVALID",
  EMAIL_INVALID: "TENANT_EMAIL_INVALID",
  IDENTIFIER_INVALID: "TENANT_IDENTIFIER_INVALID",
  SUBJECT_INVALID: "TENANT_SUBJECT_INVALID",
} as const);

export class TenantIdentityError extends Error {
  readonly code: (typeof TENANT_IDENTITY_ERROR_CODES)[keyof typeof TENANT_IDENTITY_ERROR_CODES];

  constructor(code: TenantIdentityError["code"], message: string) {
    super(message);
    this.name = "TenantIdentityError";
    this.code = code;
  }
}

export interface TenantIdentifiers {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly deploymentId: string;
}

export function assertTenantSlug(slug: string): void {
  if (typeof slug !== "string" || !TENANT_SLUG_PATTERN.test(slug)) {
    throw new TenantIdentityError(
      TENANT_IDENTITY_ERROR_CODES.SLUG_INVALID,
      "A tenant slug uses lowercase letters, digits and hyphens only, and is at most 32 characters",
    );
  }
}

export function normalizeTenantEmail(email: string): string {
  const normalized = typeof email === "string" ? email.normalize("NFKC").trim().toLowerCase() : "";
  const at = normalized.indexOf("@");
  if (
    normalized.length > 254 ||
    at < 1 ||
    at !== normalized.lastIndexOf("@") ||
    at === normalized.length - 1 ||
    /\s/.test(normalized) ||
    [...normalized].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new TenantIdentityError(
      TENANT_IDENTITY_ERROR_CODES.EMAIL_INVALID,
      "A tenant email must be a single plain address",
    );
  return normalized;
}

export function tenantSubjectReference(issuer: string, subject: string): string {
  if (!issuer || !subject || issuer.includes("\0") || subject.includes("\0"))
    throw new TenantIdentityError(
      TENANT_IDENTITY_ERROR_CODES.SUBJECT_INVALID,
      "A login subject needs a non-empty issuer and subject",
    );
  return createHash("sha256").update(`${issuer}\0${subject}`).digest("hex");
}

export function executionWorkerInstanceId(deploymentId: string): string {
  return `execution-worker:${deploymentId}`;
}

export function agentServiceInstanceId(deploymentId: string): string {
  return `agent-service:${deploymentId}`;
}

export function assertTenantIdentifiers(identifiers: TenantIdentifiers): void {
  try {
    assertTenantSlug(identifiers.tenantId);
    createOwnerId(identifiers.ownerId);
    createAgentId(identifiers.agentId);
    createDeploymentId(identifiers.deploymentId);
    for (const value of [
      identifiers.tenantId,
      identifiers.ownerId,
      identifiers.agentId,
      identifiers.deploymentId,
      executionWorkerInstanceId(identifiers.deploymentId),
      agentServiceInstanceId(identifiers.deploymentId),
    ])
      machineString.parse(value);
  } catch (error) {
    if (error instanceof TenantIdentityError) throw error;
    throw new TenantIdentityError(
      TENANT_IDENTITY_ERROR_CODES.IDENTIFIER_INVALID,
      "A tenant identifier is rejected by the domain or gateway validators",
    );
  }
}

export function deriveTenantIdentifiers(slug: string): TenantIdentifiers {
  assertTenantSlug(slug);
  const identifiers = Object.freeze({
    tenantId: slug,
    ownerId: `owner:${slug}`,
    agentId: `agent:${slug}`,
    deploymentId: `deployment:${slug}`,
  });
  assertTenantIdentifiers(identifiers);
  return identifiers;
}
