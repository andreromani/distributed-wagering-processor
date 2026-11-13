import type { ReconciliationSnapshot } from './wallet-reconciliation-reader.js';

export interface ReconciliationObserver {
  divergence(snapshot: ReconciliationSnapshot, correlationId: string): void;
}
