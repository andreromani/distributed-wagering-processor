import { EntityManager } from 'typeorm';
import type { InboxRecord } from '../../../application/ports/financial-context.js';
import { InboxRowSchema } from '../entities/inbox-message.schema.js';
import { inboxFromRow, inboxToRow } from '../mappers/inbox-message.mapper.js';
import { requireTransaction } from './transaction-context.js';

export class TypeOrmInboxRepository {
  constructor(private readonly manager: EntityManager) {}

  async insert(message: InboxRecord): Promise<void> {
    requireTransaction(this.manager);

    await this.manager.insert(InboxRowSchema, inboxToRow(message));
  }

  async markProcessed(
    consumerName: string,
    messageId: string,
    at: Date,
  ): Promise<void> {
    requireTransaction(this.manager);

    const result = await this.manager
      .createQueryBuilder()
      .update(InboxRowSchema)
      .set({ processed_at: () => 'COALESCE(processed_at, :processedAt)' })
      .where('consumer_name = :consumerName AND message_id = :messageId', {
        consumerName,
        messageId,
        processedAt: at,
      })
      .execute();

    if (result.affected !== 1) {
      throw new Error('Inbox receipt not found');
    }
  }

  async find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxRecord | undefined> {
    const row = await this.manager.findOneBy(InboxRowSchema, {
      consumer_name: consumerName,
      message_id: messageId,
    });

    return row ? inboxFromRow(row) : undefined;
  }
}
