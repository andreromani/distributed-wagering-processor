import type { Wallet } from '../entities/wallet.js';

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;

  findById(id: string): Promise<Wallet | undefined>;

  findByPlayerCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | undefined>;

  findByIdForUpdate(id: string): Promise<Wallet | undefined>;

  update(wallet: Wallet): Promise<void>;
}
