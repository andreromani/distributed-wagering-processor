import { EntityManager } from 'typeorm';
import type { OutboxRecord } from '../../../application/ports/financial-context.js';
import { OutboxRowSchema } from '../entities/outbox-message.schema.js';
import { requireTransaction } from './transaction-context.js';

export class TypeOrmOutboxRepository {
  constructor(private readonly manager: EntityManager) {}

  async insert(message: OutboxRecord): Promise<void> {
    requireTransaction(this.manager);

    await this.manager.query(
      'INSERT INTO outbox_messages(id,aggregate_id,event_type,payload,occurred_at,attempts,next_attempt_at,published_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)',
      [
        message.id,
        message.aggregateId,
        message.eventType,
        JSON.stringify(message.payload),
        message.occurredAt,
        message.attempts,
        message.nextAttemptAt ?? null,
        message.publishedAt ?? null,
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

    return rows.map((row) => ({
      id: row.id,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload,
      occurredAt: row.occurred_at,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at ?? undefined,
      publishedAt: row.published_at ?? undefined,
    }));
  }
}
