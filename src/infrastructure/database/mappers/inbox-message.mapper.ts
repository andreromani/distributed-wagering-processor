import type { InboxRecord } from '../../../application/ports/financial-context.js';
import { InboxMessage } from '../../../domain/entities/inbox-message.js';
import type { InboxRow } from '../entities/inbox-message.schema.js';

export function inboxToRow(message: InboxRecord): InboxRow {
  return {
    consumer_name: message.consumerName,
    message_id: message.messageId,
    payload_hash: message.payloadHash,
    received_at: message.receivedAt,
    processed_at: message.processedAt ?? null,
  };
}

export function inboxFromRow(row: InboxRow): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: row.consumer_name,
    messageId: row.message_id,
    payloadHash: row.payload_hash,
    receivedAt: row.received_at,
    processedAt: row.processed_at ?? undefined,
  });
}
