import { EntitySchema } from 'typeorm';

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
