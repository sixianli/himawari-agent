import { createHash, timingSafeEqual } from "node:crypto";
import type { ClockPort } from "@himawari-agent/application";

export const AUTHORIZED_PER_MINUTE = 30;
export const UNAUTHORIZED_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

export type BearerAdmission = "ok" | "unauthorized" | "rate_limited";

export class AdmissionWindows {
  private readonly authorized: number[] = [];
  private readonly unauthorized: number[] = [];
  private readonly clock: ClockPort;
  private readonly authorizedPerMinute: number;

  constructor(clock: ClockPort, authorizedPerMinute = AUTHORIZED_PER_MINUTE) {
    this.clock = clock;
    this.authorizedPerMinute = authorizedPerMinute;
  }

  used(): number {
    const now = Date.parse(this.clock.now());
    return this.authorized.filter((at) => now - at < WINDOW_MS).length;
  }

  admit(matches: boolean): BearerAdmission {
    const now = Date.parse(this.clock.now());
    const window = matches ? this.authorized : this.unauthorized;
    while (window.length > 0 && now - (window[0] as number) >= WINDOW_MS) window.shift();
    if (window.length >= (matches ? this.authorizedPerMinute : UNAUTHORIZED_PER_MINUTE))
      return "rate_limited";
    window.push(now);
    return matches ? "ok" : "unauthorized";
  }
}

export class BearerGate {
  private readonly secretDigest: Buffer;
  private readonly windows: AdmissionWindows;

  constructor(clock: ClockPort, secret: string, minimumLength: number, tooShort: string) {
    if (secret.length < minimumLength) throw new Error(tooShort);
    this.secretDigest = createHash("sha256").update(secret).digest();
    this.windows = new AdmissionWindows(clock);
  }

  matches(authorization: string | undefined): boolean {
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    return timingSafeEqual(createHash("sha256").update(bearer).digest(), this.secretDigest);
  }

  admit(authorization: string | undefined): BearerAdmission {
    return this.windows.admit(this.matches(authorization));
  }
}
