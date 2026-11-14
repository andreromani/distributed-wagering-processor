import { instanceId } from '../config/instance-id.js';
import type { ProcessWagerResult } from '../../application/use-cases/process-wager-transaction.use-case.js';
import type { MessagingMetric } from '../messaging/messaging-diagnostics.js';

type Source = 'http' | 'sqs' | 'reference';
type Sample = { name: string; labels: string; value: number };
const buckets = [0.005, 0.025, 0.1, 0.5, 1, 5, 15, 30];
const messagingNames: Record<MessagingMetric, string> = {
  received: 'sqs_received_total',
  processed: 'sqs_processed_total',
  replays: 'sqs_replays_total',
  rejected: 'sqs_rejected_total',
  retries: 'sqs_retries_total',
  dlq: 'sqs_dlq_forwarded_total',
  ackFailures: 'sqs_ack_failures_total',
  published: 'outbox_broker_confirmations_total',
  publishFailures: 'outbox_publish_failures_total',
  pending: 'outbox_pending_events',
  exhausted: 'sqs_delivery_exhausted_total',
  visibilityFailures: 'sqs_visibility_failures_total',
  pendingReferenceResolved: 'reference_resolved_total',
  pendingReferenceRescheduled: 'reference_rescheduled_total',
  pendingReferenceRejected: 'reference_rejected_total',
  pendingReferenceFailures: 'reference_failures_total',
};
const conflictCodes = new Set([
  'IDEMPOTENCY_CONFLICT',
  'INBOX_CONFLICT',
  'EXTERNAL_IDENTITY_CONFLICT',
]);

export class OperationalMetrics {
  readonly instanceId = instanceId();
  readonly #counters = new Map<string, Sample>();
  readonly #gauges = new Map<string, number>([
    ['outbox_pending_events', 0],
    ['outbox_oldest_pending_age_seconds', 0],
    ['reference_pending_transactions', 0],
    ['sqs_dlq_messages', 0],
    ['metrics_database_collection_success', 0],
    ['metrics_sqs_collection_success', 0],
  ]);
  readonly #durations = new Map<
    Source,
    { count: number; sum: number; buckets: number[] }
  >();

  constructor() {
    for (const name of Object.values(messagingNames)) {
      if (name.endsWith('_total')) {
        this.increment(name, '', 0);
      }
    }

    this.increment('sql_lock_conflicts_total', '', 0);
    this.increment('sql_transient_failures_total', '', 0);
    this.increment('reconciliation_divergences_total', '', 0);
    for (const source of ['http', 'sqs', 'reference'] as const) {
      this.increment('replays_total', `source="${source}"`, 0);
      for (const status of [
        'PENDING',
        'PENDING_REFERENCE',
        'PROCESSED',
        'REJECTED',
        'FAILED',
      ]) {
        for (const replay of [false, true]) {
          this.increment(
            'transactions_total',
            `source="${source}",status="${status}",replay="${replay}"`,
            0,
          );
        }
      }

      this.#durations.set(source, {
        count: 0,
        sum: 0,
        buckets: buckets.map(() => 0),
      });
    }
  }

  messaging(metric: MessagingMetric): void {
    if (metric !== 'pending') {
      this.increment(messagingNames[metric]);
    }
  }

  processing(result: ProcessWagerResult, source: Source): void {
    this.increment(
      'transactions_total',
      `source="${source}",status="${result.status}",replay="${result.idempotentReplay}"`,
    );
    if (result.idempotentReplay) {
      this.increment('replays_total', `source="${source}"`);
    }
  }

  duration(source: Source, seconds: number): void {
    const values = this.#durations.get(source);
    if (!values || !Number.isFinite(seconds) || seconds < 0) {
      return;
    }

    values.count += 1;
    values.sum += seconds;
    for (let i = 0; i < buckets.length; i += 1) {
      if (seconds <= (buckets[i] ?? Infinity)) {
        values.buckets[i] = (values.buckets[i] ?? 0) + 1;
      }
    }
  }

  http(statusCode: number): void {
    const status = Math.min(5, Math.max(1, Math.floor(statusCode / 100)));
    this.increment('http_requests_total', `status_class="${status}xx"`);
  }

  conflict(code: unknown): void {
    if (typeof code === 'string' && conflictCodes.has(code)) {
      this.increment('identity_conflicts_total', `code="${code}"`);
    }
  }

  sqlFailure(error: unknown, transient: boolean): void {
    if (transient) {
      this.increment('sql_transient_failures_total');
    }

    const driver: unknown =
      error && typeof error === 'object' && 'driverError' in error
        ? error.driverError
        : error;
    if (
      driver &&
      typeof driver === 'object' &&
      'code' in driver &&
      ['40001', '40P01', '55P03'].includes(String(driver.code))
    ) {
      this.increment('sql_lock_conflicts_total');
    }
  }

  divergence(): void {
    this.increment('reconciliation_divergences_total');
  }

  database(pending: number, lagSeconds: number, references: number): void {
    this.#gauges.set('outbox_pending_events', pending);
    this.#gauges.set('outbox_oldest_pending_age_seconds', lagSeconds);
    this.#gauges.set('reference_pending_transactions', references);
    this.databaseAvailable(true);
  }

  databaseAvailable(available: boolean): void {
    this.#gauges.set('metrics_database_collection_success', available ? 1 : 0);
  }

  dlq(messages: number): void {
    this.#gauges.set('sqs_dlq_messages', messages);
    this.sqsAvailable(true);
  }

  sqsAvailable(available: boolean): void {
    this.#gauges.set('metrics_sqs_collection_success', available ? 1 : 0);
  }

  private increment(name: string, labels = '', value = 1): void {
    const key = name + labels;
    const previous = this.#counters.get(key);
    this.#counters.set(key, {
      name,
      labels,
      value: (previous?.value ?? 0) + value,
    });
  }

  render(): string {
    const lines: string[] = [];
    const families = new Map<string, Sample[]>();
    for (const sample of this.#counters.values()) {
      const samples = families.get(sample.name) ?? [];
      samples.push(sample);
      families.set(sample.name, samples);
    }

    for (const [name, samples] of families) {
      lines.push(`# TYPE wager_${name} counter`);
      for (const sample of samples) {
        lines.push(
          `wager_${sample.name}{instance_id="${this.instanceId}"${sample.labels ? ',' + sample.labels : ''}} ${sample.value}`,
        );
      }
    }

    for (const [name, value] of this.#gauges) {
      const scope = name.startsWith('metrics_') ? 'instance' : 'shared';
      lines.push(`# TYPE wager_${name} gauge`);
      lines.push(
        `wager_${name}{instance_id="${this.instanceId}",scope="${scope}"} ${value}`,
      );
    }

    lines.push('# TYPE wager_processing_duration_seconds histogram');
    for (const [source, values] of this.#durations) {
      const labels = `instance_id="${this.instanceId}",source="${source}"`;
      for (let i = 0; i < buckets.length; i += 1) {
        lines.push(
          `wager_processing_duration_seconds_bucket{${labels},le="${buckets[i]}"} ${values.buckets[i]}`,
        );
      }

      lines.push(
        `wager_processing_duration_seconds_bucket{${labels},le="+Inf"} ${values.count}`,
      );
      lines.push(
        `wager_processing_duration_seconds_sum{${labels}} ${values.sum}`,
      );
      lines.push(
        `wager_processing_duration_seconds_count{${labels}} ${values.count}`,
      );
    }

    return lines.join('\n') + '\n';
  }
}
