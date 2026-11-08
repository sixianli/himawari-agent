import { createHash, timingSafeEqual } from "node:crypto";
import type { ClockPort } from "@himawari-agent/application";

export const AUTHORIZED_PER_MINUTE = 30;
export const UNAUTHORIZED_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

export type BearerAdmission = "ok" | "unauthorized" | "rate_limited";

export class BearerGate {
  private readonly secretDigest: Buffer;
  private readonly authorized: number[] = [];
  private readonly unauthorized: number[] = [];

  private readonly clock: ClockPort;

  constructor(clock: ClockPort, secret: string, minimumLength: number, tooShort: string) {
    this.clock = clock;
    if (secret.length < minimumLength) throw new Error(tooShort);
    this.secretDigest = createHash("sha256").update(secret).digest();
  }

  admit(authorization: string | undefined): BearerAdmission {
    const now = Date.parse(this.clock.now());
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const matches = timingSafeEqual(
      createHash("sha256").update(bearer).digest(),
      this.secretDigest,
    );
    const window = matches ? this.authorized : this.unauthorized;
    while (window.length > 0 && now - (window[0] as number) >= WINDOW_MS) window.shift();
    if (window.length >= (matches ? AUTHORIZED_PER_MINUTE : UNAUTHORIZED_PER_MINUTE))
      return "rate_limited";
    window.push(now);
    return matches ? "ok" : "unauthorized";
  }
}
