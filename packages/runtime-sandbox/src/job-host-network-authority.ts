/** One-shot checks over the existing authenticated Worker IPC. The task never
 * inherits this channel. A reply is usable only for its outstanding check. */
export class JobHostNetworkAuthority {
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<number, { finish: (allowed: boolean) => void }>();
  private readonly send: (message: Record<string, unknown>) => void;
  private readonly stop: () => void;
  constructor(send: (message: Record<string, unknown>) => void, stop: () => void) {
    this.send = send;
    this.stop = stop;
  }
  assertCurrent = async (): Promise<void> => {
    if (this.closed || this.pending.size >= 128) throw new Error("EGRESS_AUTHORITY_UNAVAILABLE");
    const checkId = ++this.nextId;
    await new Promise<void>((resolve, reject) => {
      // Same validity bound as Job Host/Worker supervision. Heartbeats alone
      // cannot keep an unanswered authority request alive.
      const timer = setTimeout(() => {
        this.close();
        this.stop();
      }, 1500);
      this.pending.set(checkId, {
        finish: (allowed) => {
          clearTimeout(timer);
          this.pending.delete(checkId);
          if (allowed && !this.closed) resolve();
          else reject(new Error("EGRESS_AUTHORITY_REJECTED"));
        },
      });
      try {
        this.send({ type: "authority_check", checkId });
      } catch {
        this.close();
        this.stop();
      }
    });
  };
  receive(checkId: unknown, allowed: unknown): void {
    if (this.closed) return;
    if (typeof checkId !== "number" || typeof allowed !== "boolean" || !this.pending.has(checkId)) {
      this.close();
      this.stop();
      return;
    }
    if (!allowed) {
      this.close();
      this.stop();
      return;
    }
    this.pending.get(checkId)?.finish(true);
  }
  close(): void {
    this.closed = true;
    for (const entry of this.pending.values()) entry.finish(false);
  }
}
