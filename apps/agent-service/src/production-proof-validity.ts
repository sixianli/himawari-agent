export const LIVE_PROOF_VALIDITY_MS = 1000;
export const RETAINED_RELEASE_PROOF_VALIDITY_MS = 30_000;

export function proofValidUntil(checkedAt: string, retainedRelease: boolean): string {
  const validityMs = retainedRelease ? RETAINED_RELEASE_PROOF_VALIDITY_MS : LIVE_PROOF_VALIDITY_MS;
  return new Date(Date.parse(checkedAt) + validityMs).toISOString();
}
