import { EntityManager } from 'typeorm';
import type { InboxRecord } from '../../../application/ports/financial-context.js';
import { InboxRowSchema } from '../entities/inbox-message.schema.js';
import { requireTransaction } from './transaction-context.js';

export class TypeOrmInboxRepository {
  constructor(private readonly manager: EntityManager) {}

  async insert(message: InboxRecord): Promise<void> {
    requireTransaction(this.manager);

    await this.manager.insert(InboxRowSchema, {
      consumer_name: message.consumerName,
      message_id: message.messageId,
      payload_hash: message.payloadHash,
      received_at: message.receivedAt,
      processed_at: message.processedAt ?? null,
    });
  }

  async find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxRecord | undefined> {
    const row = await this.manager.findOneBy(InboxRowSchema, {
      consumer_name: consumerName,
      message_id: messageId,
    });

    return row
      ? {
          consumerName: row.consumer_name,
          messageId: row.message_id,
          payloadHash: row.payload_hash,
          receivedAt: row.received_at,
          processedAt: row.processed_at ?? undefined,
        }
      : undefined;
  }
}
