import {
  outboxFromRow,
  outboxToRow,
} from '../mappers/outbox-message.mapper.js';
import { EntityManager } from 'typeorm';
import type { OutboxRecord } from '../../../application/ports/financial-context.js';
import { OutboxRowSchema } from '../entities/outbox-message.schema.js';
import { requireTransaction } from './transaction-context.js';

export class TypeOrmOutboxRepository {
  constructor(private readonly manager: EntityManager) {}

  async insert(message: OutboxRecord): Promise<void> {
    requireTransaction(this.manager);

    const row = outboxToRow(message);

    await this.manager.query(
      'INSERT INTO outbox_messages(id,aggregate_id,event_type,payload,occurred_at,attempts,next_attempt_at,published_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)',
      [
        row.id,
        row.aggregate_id,
        row.event_type,
        JSON.stringify(row.payload),
        row.occurred_at,
        row.attempts,
        row.next_attempt_at,
        row.published_at,
      ],
    );
  }

  async lockDue(now: Date, limit: number): Promise<OutboxRecord[]> {
    requireTransaction(this.manager);

    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Invalid outbox limit');
    }

    const rows = await this.manager
      .createQueryBuilder(OutboxRowSchema, 'message')
      .where(
        'message.published_at IS NULL AND (message.next_attempt_at IS NULL OR message.next_attempt_at <= :now)',
        { now },
      )
      .orderBy('message.next_attempt_at', 'ASC', 'NULLS FIRST')
      .addOrderBy('message.occurred_at', 'ASC')
      .addOrderBy('message.id', 'ASC')
      .take(limit)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getMany();

    return rows.map(outboxFromRow);
  }
}
