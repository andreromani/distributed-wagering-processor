import { EntitySchema } from 'typeorm';

export interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
}

export const OutboxRowSchema = new EntitySchema<OutboxRow>({
  name: 'OutboxRow',
  tableName: 'outbox_messages',
  columns: {
    id: { type: 'text', primary: true },
    aggregate_id: { type: 'text' },
    event_type: { type: 'text' },
    payload: { type: 'jsonb' },
    occurred_at: { type: 'timestamptz' },
    attempts: { type: 'integer' },
    next_attempt_at: { type: 'timestamptz', nullable: true },
    published_at: { type: 'timestamptz', nullable: true },
  },
});
