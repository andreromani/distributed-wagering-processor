import { WalletRowSchema } from './wallet.schema.js';
import { WagerRowSchema } from './wager-transaction.schema.js';
import { LedgerRowSchema } from './wallet-ledger.schema.js';
import { InboxRowSchema } from './inbox-message.schema.js';
import { OutboxRowSchema } from './outbox-message.schema.js';

export const financialEntities = [
  WalletRowSchema,
  WagerRowSchema,
  LedgerRowSchema,
  InboxRowSchema,
  OutboxRowSchema,
];
