import { EntitySchema } from 'typeorm';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  FailureCode,
  LedgerDirection,
} from '../../../domain/financial.types.js';

export interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export const WalletRowSchema = new EntitySchema<WalletRow>({
  name: 'WalletRow',
  tableName: 'wallets',
  columns: {
    id: { type: 'text', primary: true },
    player_id: { type: 'text' },
    currency: { type: 'text' },
    balance: { type: 'numeric', precision: 30, scale: 2 },
    version: { type: 'integer' },
    created_at: { type: 'timestamptz' },
    updated_at: { type: 'timestamptz' },
  },
});

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

export interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
}

export const LedgerRowSchema = new EntitySchema<LedgerRow>({
  name: 'LedgerRow',
  tableName: 'wallet_ledger_entries',
  columns: {
    id: { type: 'text', primary: true },
    wallet_id: { type: 'text' },
    transaction_id: { type: 'text' },
    direction: { type: 'text' },
    amount: { type: 'numeric', precision: 30, scale: 2 },
    currency: { type: 'text' },
    balance_before: { type: 'numeric', precision: 30, scale: 2 },
    balance_after: { type: 'numeric', precision: 30, scale: 2 },
    created_at: { type: 'timestamptz' },
  },
});

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

export const financialEntities = [
  WalletRowSchema,
  WagerRowSchema,
  LedgerRowSchema,
  InboxRowSchema,
  OutboxRowSchema,
];
