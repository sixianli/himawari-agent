import type {
  ClockPort,
  ProductStateRepositoryPort,
  ReliableEventSinkPort,
} from "../ports/index.js";

export interface PublishPendingResult {
  readonly attempted: number;
  readonly published: number;
  readonly duplicates: number;
}

export class ReliableEventPublisher {
  private readonly repository: ProductStateRepositoryPort;
  private readonly sink: ReliableEventSinkPort;
  private readonly clock: ClockPort;

  constructor(
    repository: ProductStateRepositoryPort,
    sink: ReliableEventSinkPort,
    clock: ClockPort,
  ) {
    this.repository = repository;
    this.sink = sink;
    this.clock = clock;
  }

  async publishPending(limit: number): Promise<PublishPendingResult> {
    const pending = await this.repository.listPending(limit);
    let published = 0;
    let duplicates = 0;

    for (const event of pending) {
      const delivery = await this.sink.publish(event);
      if (delivery.outcome === "published") published += 1;
      else duplicates += 1;
      await this.repository.markPublished(event.id, this.clock.now());
    }

    return Object.freeze({ attempted: pending.length, published, duplicates });
  }
}
