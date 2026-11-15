import type { ReconciliationObserver } from '../../application/ports/reconciliation-observer.js';
import type { ReconciliationSnapshot } from '../../application/ports/wallet-reconciliation-reader.js';
import { JsonLog } from '../observability/json-log.js';
import type { OperationalMetrics } from '../observability/operational-metrics.js';
import type { ProcessWagerResult } from '../../application/use-cases/process-wager-transaction.use-case.js';

export class FinancialDiagnostics implements ReconciliationObserver {
  #reconciliationDivergences = 0;

  constructor(
    private readonly sink: (
      record: Readonly<Record<string, unknown>>,
    ) => void = (record) => console.log(JSON.stringify(record)),
    private readonly metrics?: OperationalMetrics,
  ) {}

  get reconciliationDivergences(): number {
    return this.#reconciliationDivergences;
  }

  divergence(snapshot: ReconciliationSnapshot, correlationId: string): void {
    this.#reconciliationDivergences += 1;
    this.metrics?.divergence();
    this.record({
      level: 'error',
      event: 'wallet_reconciliation_divergence',
      walletId: snapshot.walletId,
      correlationId,
    });
  }

  record(record: Readonly<Record<string, unknown>>): void {
    this.metrics?.conflict(record.code);
    const level = record.level;
    new JsonLog(this.sink).emit(
      level === 'debug' ||
        level === 'info' ||
        level === 'warn' ||
        level === 'error' ||
        level === 'fatal'
        ? level
        : 'info',
      typeof record.event === 'string' ? record.event : 'financial_diagnostic',
      record,
    );
  }

  processing(
    result: ProcessWagerResult,
    identifiers: Readonly<Record<string, unknown>>,
  ): void {
    this.metrics?.processing(result, 'http');
    this.record({
      event: 'financial_result',
      source: 'http',
      ...identifiers,
      transactionId: result.transactionId,
      status: result.status,
      idempotentReplay: result.idempotentReplay,
      failureCode: result.failureCode,
    });
  }

  httpFinished(statusCode: number): void {
    this.metrics?.http(statusCode);
  }

  duration(seconds: number): void {
    this.metrics?.duration('http', seconds);
  }
}
