import type { OutboxRecord } from '../../../application/ports/financial-context.js';
import { OutboxMessage } from '../../../domain/entities/outbox-message.js';
import type { OutboxRow } from '../entities/outbox-message.schema.js';

export function outboxToRow(message: OutboxRecord): OutboxRow {
  return {
    id: message.id,
    aggregate_id: message.aggregateId,
    event_type: message.eventType,
    payload: message.payload,
    occurred_at: message.occurredAt,
    attempts: message.attempts,
    next_attempt_at: message.nextAttemptAt ?? null,
    published_at: message.publishedAt ?? null,
  };
}

export function outboxFromRow(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    publishedAt: row.published_at ?? undefined,
  });
}
