import type { IntegrationEvent } from '../events/integration-event.js';
import { immutableSnapshot } from '../events/immutable-snapshot.js';
import { timestamp } from '../errors/timestamp.js';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly #payload: Record<string, unknown>;
  readonly #occurredAt: number;
  readonly #attempts: number;
  readonly #nextAttemptAt: number | undefined;
  readonly #publishedAt: number | undefined;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.#payload = immutableSnapshot(state.payload);
    this.#occurredAt = timestamp(state.occurredAt);
    this.#attempts = state.attempts;
    this.#nextAttemptAt =
      state.nextAttemptAt === undefined
        ? undefined
        : timestamp(state.nextAttemptAt);
    this.#publishedAt =
      state.publishedAt === undefined
        ? undefined
        : timestamp(state.publishedAt);
    Object.freeze(this);
  }

  static enqueue<T>(event: IntegrationEvent<T>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get payload(): Record<string, unknown> {
    return immutableSnapshot(this.#payload);
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAt);
  }

  get attempts(): number {
    return this.#attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this.#nextAttemptAt === undefined
      ? undefined
      : new Date(this.#nextAttemptAt);
  }

  get publishedAt(): Date | undefined {
    return this.#publishedAt === undefined
      ? undefined
      : new Date(this.#publishedAt);
  }

  isPending(): boolean {
    return this.#publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this.#nextAttemptAt === undefined ||
        this.#nextAttemptAt <= timestamp(now))
    );
  }
}
