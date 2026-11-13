import type { OutboxMessage } from '../../domain/entities/outbox-message.js';

export interface IntegrationEventPublisher {
  publish(event: OutboxMessage, signal?: AbortSignal): Promise<void>;
}
