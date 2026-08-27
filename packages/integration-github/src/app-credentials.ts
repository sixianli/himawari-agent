import type { GitHubInstallationRecord } from "@himawari-agent/application";

/**
 * Permissions derived from the read surface used by the monitor. Every write
 * capability remains explicitly absent/none so an installation cannot silently
 * broaden into a GitHub mutation client.
 */
export const GITHUB_READ_ONLY_APP_PERMISSIONS = Object.freeze({
  actions: "read",
  checks: "read",
  contents: "read",
  deployments: "none",
  issues: "read",
  metadata: "read",
  pull_requests: "read",
  statuses: "read",
  workflows: "read",
} as const);

export const GITHUB_WRITE_OPERATIONS = Object.freeze([
  "git.push",
  "pull_request.comment",
  "pull_request.merge",
  "workflow.dispatch",
  "deployment.create",
  "credential.read",
] as const);

export interface GitHubAppPrivateKeySource {
  resolve(secretRef: string): Promise<Uint8Array | string>;
}

export interface GitHubInstallationTokenIssuer {
  issue(input: {
    readonly providerInstallationId: string;
    readonly privateKey: Uint8Array | string;
    readonly repositoryIds: readonly string[];
    readonly permissions: typeof GITHUB_READ_ONLY_APP_PERMISSIONS;
  }): Promise<{ readonly token: string; readonly expiresAt: string }>;
}

export interface GitHubInstallationToken {
  /** Token material is intentionally process-memory only and never serialised. */
  readonly value: string;
  readonly expiresAt: string;
  readonly installationRef: string;
  readonly repositoryIds: readonly string[];
}

export class GitHubAppCredentialError extends Error {
  readonly code:
    | "GITHUB_INSTALLATION_REVOKED"
    | "GITHUB_TOKEN_SCOPE_REJECTED"
    | "GITHUB_TOKEN_ISSUE_FAILED";

  constructor(code: GitHubAppCredentialError["code"], message: string) {
    super(message);
    this.name = "GitHubAppCredentialError";
    this.code = code;
  }
}

/** Resolves App credentials just-in-time and caches only the short-lived token. */
export class GitHubInstallationTokenAdapter {
  private readonly source: GitHubAppPrivateKeySource;
  private readonly issuer: GitHubInstallationTokenIssuer;
  private readonly now: () => string;
  private readonly cache = new Map<string, GitHubInstallationToken>();

  constructor(input: {
    readonly source: GitHubAppPrivateKeySource;
    readonly issuer: GitHubInstallationTokenIssuer;
    readonly now: () => string;
  }) {
    this.source = input.source;
    this.issuer = input.issuer;
    this.now = input.now;
  }

  async get(
    installation: GitHubInstallationRecord,
    repositoryIds: readonly string[],
  ): Promise<GitHubInstallationToken> {
    if (installation.status !== "active") {
      throw new GitHubAppCredentialError(
        "GITHUB_INSTALLATION_REVOKED",
        `GitHub installation ${installation.id} is revoked`,
      );
    }
    const repositories = [...new Set(repositoryIds)].sort();
    if (repositories.length === 0 || repositories.some((id) => !/^\d+$/.test(id))) {
      throw new GitHubAppCredentialError(
        "GITHUB_TOKEN_SCOPE_REJECTED",
        "GitHub installation tokens require an explicit repository allowlist",
      );
    }
    const key = `${installation.id}:${repositories.join(",")}`;
    const cached = this.cache.get(key);
    if (cached && new Date(cached.expiresAt).valueOf() - new Date(this.now()).valueOf() > 60_000) {
      return cloneToken(cached);
    }
    const privateKey = await this.source.resolve(installation.secretRef).catch(() => {
      throw new GitHubAppCredentialError(
        "GITHUB_TOKEN_ISSUE_FAILED",
        "GitHub App private key could not be resolved",
      );
    });
    const issued = await this.issuer
      .issue({
        providerInstallationId: installation.providerInstallationId,
        privateKey,
        repositoryIds: repositories,
        permissions: GITHUB_READ_ONLY_APP_PERMISSIONS,
      })
      .catch(() => {
        throw new GitHubAppCredentialError(
          "GITHUB_TOKEN_ISSUE_FAILED",
          "GitHub installation token could not be issued",
        );
      });
    if (!issued.token || new Date(issued.expiresAt).valueOf() <= new Date(this.now()).valueOf()) {
      throw new GitHubAppCredentialError(
        "GITHUB_TOKEN_ISSUE_FAILED",
        "GitHub installation token is missing or already expired",
      );
    }
    const token: GitHubInstallationToken = Object.freeze({
      value: issued.token,
      expiresAt: issued.expiresAt,
      installationRef: installation.id,
      repositoryIds: Object.freeze(repositories),
    });
    this.cache.set(key, token);
    return cloneToken(token);
  }

  revoke(installationRef?: string): void {
    if (!installationRef) {
      this.cache.clear();
      return;
    }
    for (const [key, token] of this.cache) {
      if (token.installationRef === installationRef) this.cache.delete(key);
    }
  }

  cacheSize(): number {
    return this.cache.size;
  }
}

function cloneToken(token: GitHubInstallationToken): GitHubInstallationToken {
  return Object.freeze({ ...token, repositoryIds: Object.freeze([...token.repositoryIds]) });
}
