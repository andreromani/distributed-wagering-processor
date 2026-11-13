import { DataSource } from 'typeorm';
import type {
  WalletReconciliationReader,
  ReconciliationSnapshot,
} from '../../../application/ports/wallet-reconciliation-reader.js';
import { ensureDatabaseConnection } from '../database-connection.js';
import { persistenceError } from '../mappers/persistence-error.mapper.js';

export class TypeOrmWalletReconciliationReader implements WalletReconciliationReader {
  constructor(private readonly source: DataSource) {}

  async read(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    try {
      await ensureDatabaseConnection(this.source);
      const [row] = await this.source.query<
        {
          wallet_id: string;
          currency: string;
          stored_balance: string;
          calculated_balance: string;
          difference: string;
          checked_entries: string;
        }[]
      >(
        `SELECT w.id AS wallet_id,w.currency,w.balance::text AS stored_balance,
          a.balance::text AS calculated_balance,(w.balance-a.balance)::text AS difference,a.entries::text AS checked_entries
         FROM wallets w CROSS JOIN LATERAL (
          SELECT COALESCE(sum(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0.00) AS balance,count(*) AS entries
          FROM wallet_ledger_entries WHERE wallet_id=w.id
         ) a WHERE w.id=$1`,
        [walletId],
      );
      if (!row) {
        return undefined;
      }
      const checkedEntries = Number(row.checked_entries);
      if (!Number.isSafeInteger(checkedEntries)) {
        throw new Error('Ledger entry count exceeds supported range');
      }
      return {
        walletId: row.wallet_id,
        currency: row.currency,
        storedBalance: row.stored_balance,
        calculatedBalance: row.calculated_balance,
        difference: row.difference,
        checkedEntries,
      };
    } catch (error) {
      throw persistenceError(error);
    }
  }
}
