export interface ReconciliationSnapshot {
  walletId: string;
  currency: string;
  storedBalance: string;
  calculatedBalance: string;
  difference: string;
  checkedEntries: number;
}

export interface WalletReconciliationReader {
  read(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}
