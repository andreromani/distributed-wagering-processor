import { EntitySchema } from 'typeorm';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  FailureCode,
} from '../../../domain/financial.types.js';

export interface WagerRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: WagerTransactionStatus;
  failure_code: FailureCode | null;
  created_at: Date;
  processed_at: Date | null;
  result_balance: string | null;
  result_version: number | null;
  reference_attempts: number;
  next_attempt_at: Date | null;
}

export const WagerRowSchema = new EntitySchema<WagerRow>({
  name: 'WagerRow',
  tableName: 'wager_transactions',
  columns: {
    id: { type: 'text', primary: true },
    provider_id: { type: 'text' },
    external_transaction_id: { type: 'text' },
    idempotency_key: { type: 'text' },
    payload_hash: { type: 'text' },
    wallet_id: { type: 'text' },
    player_id: { type: 'text' },
    round_id: { type: 'text' },
    game_id: { type: 'text' },
    kind: { type: 'text' },
    amount: { type: 'numeric', precision: 30, scale: 2 },
    currency: { type: 'text' },
    reference_external_transaction_id: { type: 'text', nullable: true },
    reference_transaction_id: { type: 'text', nullable: true },
    status: { type: 'text' },
    failure_code: { type: 'text', nullable: true },
    created_at: { type: 'timestamptz' },
    processed_at: { type: 'timestamptz', nullable: true },
    result_balance: {
      type: 'numeric',
      precision: 30,
      scale: 2,
      nullable: true,
    },
    result_version: { type: 'integer', nullable: true },
    reference_attempts: { type: 'integer' },
    next_attempt_at: { type: 'timestamptz', nullable: true },
  },
});
