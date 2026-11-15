import { EntityManager } from 'typeorm';
import type { Wallet } from '../../../domain/entities/wallet.js';
import type { WalletRepository } from '../../../domain/repositories/wallet.repository.js';
import { WalletRowSchema } from '../entities/wallet.schema.js';
import { walletToRow, walletFromRow } from '../mappers/wallet.mapper.js';
import { requireTransaction } from './transaction-context.js';
import {
  observeFinancial,
  type FinancialObservation,
} from '../../../application/ports/financial-observer.js';

export class TypeOrmWalletRepository implements WalletRepository {
  constructor(
    private readonly manager: EntityManager,
    private readonly observation?: FinancialObservation,
  ) {}

  async insert(wallet: Wallet): Promise<void> {
    requireTransaction(this.manager);

    await this.manager.insert(WalletRowSchema, walletToRow(wallet));
  }

  async findById(id: string) {
    const row = await this.manager.findOneBy(WalletRowSchema, { id });

    return row ? walletFromRow(row) : undefined;
  }

  async findByPlayerCurrency(playerId: string, currency: string) {
    const row = await this.manager.findOneBy(WalletRowSchema, {
      player_id: playerId,
      currency,
    });

    return row ? walletFromRow(row) : undefined;
  }

  async findByIdForUpdate(id: string) {
    requireTransaction(this.manager);
    observeFinancial(this.observation, 'wallet_lock_requested', {
      walletId: id,
    });
    const started = performance.now();

    const row = await this.manager.findOne(WalletRowSchema, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (row) {
      observeFinancial(this.observation, 'wallet_lock_acquired', {
        walletId: id,
        durationMs: performance.now() - started,
      });
    }

    return row ? walletFromRow(row) : undefined;
  }

  async update(wallet: Wallet): Promise<void> {
    requireTransaction(this.manager);

    const result = await this.manager.update(
      WalletRowSchema,
      { id: wallet.id },
      {
        balance: wallet.balance.toString(),
        version: wallet.version,
        updated_at: wallet.updatedAt,
      },
    );

    if (result.affected !== 1) {
      throw new Error('Wallet not found');
    }
  }
}
