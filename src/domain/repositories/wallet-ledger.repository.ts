import type { WalletLedgerEntry } from '../entities/wallet-ledger-entry.js';

export interface LedgerPageEntry {
  entry: WalletLedgerEntry;
  position: string;
}

export interface LedgerRepository {
  findPage(
    walletId: string,
    limit: number,
    after?: { createdAt: string; id: string },
  ): Promise<LedgerPageEntry[]>;

  insert(entry: WalletLedgerEntry): Promise<void>;

  findByWallet(
    walletId: string,
    limit?: number,
    after?: { createdAt: Date; id: string },
  ): Promise<WalletLedgerEntry[]>;
}
