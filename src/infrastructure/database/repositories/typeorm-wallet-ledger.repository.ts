import { EntityManager } from 'typeorm';
import type { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.js';
import type { LedgerRepository } from '../../../domain/repositories/wallet-ledger.repository.js';
import { LedgerRowSchema } from '../entities/wallet-ledger.schema.js';
import { ledgerToRow, ledgerFromRow } from '../mappers/wallet-ledger.mapper.js';
import { requireTransaction } from './transaction-context.js';

export class TypeOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly manager: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    requireTransaction(this.manager);

    await this.manager.insert(LedgerRowSchema, ledgerToRow(entry));
  }

  async findByWallet(
    walletId: string,
    limit = 50,
    after?: { createdAt: Date; id: string },
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Invalid ledger limit');

    const query = this.manager
      .createQueryBuilder(LedgerRowSchema, 'entry')
      .where('entry.wallet_id = :walletId', { walletId });
    if (after)
      query.andWhere('(entry.created_at, entry.id) > (:createdAt, :id)', after);

    const rows = await query
      .orderBy('entry.created_at', 'ASC')
      .addOrderBy('entry.id', 'ASC')
      .take(limit)
      .getMany();

    return rows.map(ledgerFromRow);
  }
}
