import { EntitySchema } from 'typeorm';
import { LedgerDirection } from '../../../domain/financial.types.js';

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
