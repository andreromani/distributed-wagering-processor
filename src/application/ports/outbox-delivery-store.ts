import type { OutboxMessage } from '../../domain/entities/outbox-message.js';

export interface OutboxDeliveryStore {
  processNext(
    now: Date,
    action: (message: OutboxMessage) => Promise<void>,
    signal: AbortSignal,
  ): Promise<boolean>;

  countPending(): Promise<number>;
}
