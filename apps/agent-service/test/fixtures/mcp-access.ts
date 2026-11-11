import { CloudflareAccessJwtVerifier } from "@himawari-agent/platform-node";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export const MCP_ACCESS_ISSUER = "https://himawari-test.cloudflareaccess.com";
export const MCP_ACCESS_AUDIENCE = "mcp-access-audience";

export interface McpAccessFixture {
  readonly verifier: CloudflareAccessJwtVerifier;
  readonly sign: (options?: {
    readonly subject?: string;
    readonly audience?: string;
    readonly expiresInSeconds?: number;
  }) => Promise<string>;
  readonly signWithForeignKey: () => Promise<string>;
  readonly ownerSubjectRef: () => Promise<string>;
}

export async function createMcpAccess(now: () => Date): Promise<McpAccessFixture> {
  const keyPair = await generateKeyPair("RS256", { extractable: true });
  const foreign = await generateKeyPair("RS256", { extractable: true });
  const jwks = {
    keys: [{ ...(await exportJWK(keyPair.publicKey)), kid: "mcp-access-key", alg: "RS256" }],
  };
  const verifier = new CloudflareAccessJwtVerifier({
    issuer: MCP_ACCESS_ISSUER,
    audience: MCP_ACCESS_AUDIENCE,
    jwksUrl: `${MCP_ACCESS_ISSUER}/cdn-cgi/access/certs`,
    jwksFetcher: { fetch: async () => jwks },
    now,
  });
  const signWith = (
    key: Parameters<SignJWT["sign"]>[0],
    kid: string,
    {
      subject = "owner-access-subject",
      audience = MCP_ACCESS_AUDIENCE,
      expiresInSeconds = 600,
    } = {},
  ) => {
    const issuedAt = Math.floor(now().valueOf() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(MCP_ACCESS_ISSUER)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + expiresInSeconds)
      .sign(key);
  };
  return {
    verifier,
    sign: (options) => signWith(keyPair.privateKey, "mcp-access-key", options),
    signWithForeignKey: () => signWith(foreign.privateKey, "mcp-access-key"),
    ownerSubjectRef: async () =>
      (await verifier.verify(await signWith(keyPair.privateKey, "mcp-access-key")))
        .externalSubjectRef,
  };
}
