import { DataSource } from 'typeorm';
import type { OutboxDeliveryStore } from '../../../application/ports/outbox-delivery-store.js';
import { OutboxMessage } from '../../../domain/entities/outbox-message.js';
import { TypeOrmOutboxRepository } from './typeorm-outbox.repository.js';
import { ensureDatabaseConnection } from '../database-connection.js';
import { persistenceError } from '../mappers/persistence-error.mapper.js';

export class TypeOrmOutboxDeliveryStore implements OutboxDeliveryStore {
  constructor(private readonly source: DataSource) {}

  async processNext(
    now: Date,
    action: (message: OutboxMessage) => Promise<void>,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      signal.throwIfAborted();
      await ensureDatabaseConnection(this.source);
      return await this.source.transaction(
        'READ COMMITTED',
        async (manager) => {
          signal.throwIfAborted();
          const repository = new TypeOrmOutboxRepository(manager);
          const [stored] = await repository.lockDue(now, 1);
          if (!stored) {
            return false;
          }
          const message = OutboxMessage.rehydrate(stored);
          await action(message);
          signal.throwIfAborted();
          await repository.updatePublication(message);
          signal.throwIfAborted();
          return true;
        },
      );
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async countPending(): Promise<number> {
    await ensureDatabaseConnection(this.source);
    const [row] = await this.source.query<{ count: string }[]>(
      'SELECT count(*)::text AS count FROM outbox_messages WHERE published_at IS NULL',
    );
    const count = Number(row?.count ?? '0');
    if (!Number.isSafeInteger(count)) {
      throw new Error('Outbox count exceeds supported range');
    }
    return count;
  }
}
