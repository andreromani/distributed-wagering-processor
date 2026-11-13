import type { FinancialTransaction } from '../ports/financial-transaction.js';
import type { LedgerPageEntry } from '../../domain/repositories/wallet-ledger.repository.js';
import { FinancialApplicationError } from '../errors/financial-application.error.js';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '../services/ledger-cursor.js';

export class ListWalletLedgerUseCase {
  constructor(private readonly transaction: FinancialTransaction) {}

  async execute(
    walletId: string,
    limit = 50,
    cursor?: string,
  ): Promise<{ items: LedgerPageEntry[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new FinancialApplicationError('INVALID_INPUT');
    }
    const after =
      cursor === undefined ? undefined : decodeLedgerCursor(cursor, walletId);
    return this.transaction.run(async (context) => {
      if (!(await context.wallets.findById(walletId))) {
        throw new FinancialApplicationError('WALLET_NOT_FOUND');
      }
      const rows = await context.ledger.findPage(walletId, limit + 1, after);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last
            ? encodeLedgerCursor(walletId, {
                createdAt: last.position,
                id: last.entry.id,
              })
            : null,
      };
    });
  }
}
