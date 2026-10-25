export class UdsHandshakeSession<T> {
  private accepted: { value: T } | undefined;
  private pending: Promise<T> | undefined;
  private recoverable = false;
  private generation = 0;
  private readonly handshake: () => Promise<T>;
  private readonly unavailable: () => Error;

  constructor(handshake: () => Promise<T>, unavailable: () => Error) {
    this.handshake = handshake;
    this.unavailable = unavailable;
  }

  isReady(): boolean {
    return this.accepted !== undefined;
  }

  connect(): Promise<T> {
    if (this.accepted) return Promise.resolve(this.accepted.value);
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = this.handshake().then(
      (value) => {
        if (generation !== this.generation) throw this.unavailable();
        this.accepted = { value };
        this.recoverable = true;
        return value;
      },
      (error: unknown) => {
        if (generation === this.generation) this.accepted = undefined;
        throw error;
      },
    );
    this.pending = pending;
    const clear = () => {
      if (this.pending === pending) this.pending = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  }

  async ensureConnected(): Promise<void> {
    if (this.accepted) return;
    if (!this.recoverable) throw this.unavailable();
    await this.connect();
    if (!this.accepted) throw this.unavailable();
  }

  failed(): void {
    this.accepted = undefined;
  }

  disconnect(): void {
    this.generation++;
    this.accepted = undefined;
    this.pending = undefined;
    this.recoverable = false;
  }
}
