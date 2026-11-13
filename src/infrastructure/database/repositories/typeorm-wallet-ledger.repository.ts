import type { LedgerRow } from '../entities/wallet-ledger.schema.js';
import type { LedgerPageEntry } from '../../../domain/repositories/wallet-ledger.repository.js';
import { EntityManager } from 'typeorm';
import type { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.js';
import type { LedgerRepository } from '../../../domain/repositories/wallet-ledger.repository.js';
import { LedgerRowSchema } from '../entities/wallet-ledger.schema.js';
import { ledgerToRow, ledgerFromRow } from '../mappers/wallet-ledger.mapper.js';
import { requireTransaction } from './transaction-context.js';

export class TypeOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly manager: EntityManager) {}

  async findPage(
    walletId: string,
    limit: number,
    after?: { createdAt: string; id: string },
  ): Promise<LedgerPageEntry[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 101) {
      throw new Error('Invalid ledger page limit');
    }
    const rows = await this.manager.query<(LedgerRow & { position: string })[]>(
      `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position
       FROM wallet_ledger_entries WHERE wallet_id=$1
       AND ($2::timestamptz IS NULL OR (created_at,id)>($2::timestamptz,$3::text))
       ORDER BY created_at ASC,id ASC LIMIT $4`,
      [walletId, after?.createdAt ?? null, after?.id ?? null, limit],
    );
    return rows.map((row) => ({
      entry: ledgerFromRow(row),
      position: row.position,
    }));
  }

  async insert(entry: WalletLedgerEntry): Promise<void> {
    requireTransaction(this.manager);

    await this.manager.insert(LedgerRowSchema, ledgerToRow(entry));
  }

  async findByWallet(
    walletId: string,
    limit = 50,
    after?: { createdAt: Date; id: string },
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Invalid ledger limit');
    }

    const query = this.manager
      .createQueryBuilder(LedgerRowSchema, 'entry')
      .where('entry.wallet_id = :walletId', { walletId });

    if (after) {
      query.andWhere('(entry.created_at, entry.id) > (:createdAt, :id)', after);
    }

    const rows = await query
      .orderBy('entry.created_at', 'ASC')
      .addOrderBy('entry.id', 'ASC')
      .take(limit)
      .getMany();

    return rows.map(ledgerFromRow);
  }
}
