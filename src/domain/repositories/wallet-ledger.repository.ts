import type { WalletLedgerEntry } from '../entities/wallet-ledger-entry.js';

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;

  findByWallet(
    walletId: string,
    limit?: number,
    after?: { createdAt: Date; id: string },
  ): Promise<WalletLedgerEntry[]>;
}
