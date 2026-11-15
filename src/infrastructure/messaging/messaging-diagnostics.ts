import { instanceId } from '../config/instance-id.js';
import { JsonLog } from '../observability/json-log.js';
import type { OperationalMetrics } from '../observability/operational-metrics.js';
import type { ProcessWagerResult } from '../../application/use-cases/process-wager-transaction.use-case.js';

export type MessagingMetric =
  | 'received'
  | 'processed'
  | 'replays'
  | 'rejected'
  | 'retries'
  | 'dlq'
  | 'ackFailures'
  | 'published'
  | 'publishFailures'
  | 'pending'
  | 'exhausted'
  | 'visibilityFailures'
  | 'pendingReferenceResolved'
  | 'pendingReferenceRescheduled'
  | 'pendingReferenceRejected'
  | 'pendingReferenceFailures';

export class MessagingDiagnostics {
  readonly instanceId = instanceId();
  readonly #values = new Map<MessagingMetric, number>();

  constructor(
    private readonly sink: (
      record: Readonly<Record<string, unknown>>,
    ) => void = (record) => console.log(JSON.stringify(record)),
    private readonly metrics?: OperationalMetrics,
  ) {}

  increment(metric: MessagingMetric): void {
    this.#values.set(metric, (this.#values.get(metric) ?? 0) + 1);
    this.metrics?.messaging(metric);
  }

  processing(
    result: ProcessWagerResult,
    source: 'sqs' | 'reference' = 'sqs',
  ): void {
    this.metrics?.processing(result, source);
  }

  duration(seconds: number, source: 'sqs' | 'reference' = 'sqs'): void {
    this.metrics?.duration(source, seconds);
  }

  pending(value: number): void {
    this.#values.set('pending', value);
  }

  snapshot(): Readonly<Partial<Record<MessagingMetric, number>>> {
    return Object.freeze(Object.fromEntries(this.#values));
  }

  event(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    if (event === 'message_dead_lettered') {
      this.metrics?.conflict(fields.failureCode);
    }

    const level = [
      'message_received',
      'message_handling_started',
      'message_deferred',
    ].includes(event)
      ? 'debug'
      : event.includes('failed') ||
          event.includes('retry') ||
          event.includes('exhausted') ||
          event.includes('deadline') ||
          event === 'message_dead_lettered'
        ? fields.failureCode === 'PERMANENT_FAILURE' ||
          fields.failureCode === 'TERMINAL_FAILED'
          ? 'error'
          : 'warn'
        : 'info';
    new JsonLog(this.sink).emit(level, event, fields);
  }
}
