import { EntitySchema } from 'typeorm';

export interface InboxRow {
  consumer_name: string;
  message_id: string;
  payload_hash: string;
  received_at: Date;
  processed_at: Date | null;
}

export const InboxRowSchema = new EntitySchema<InboxRow>({
  name: 'InboxRow',
  tableName: 'inbox_messages',
  columns: {
    consumer_name: { type: 'text', primary: true },
    message_id: { type: 'text', primary: true },
    payload_hash: { type: 'text' },
    received_at: { type: 'timestamptz' },
    processed_at: { type: 'timestamptz', nullable: true },
  },
});
