export interface WorkerOptions {
  readonly httpEnabled: boolean;
  readonly consumerEnabled: boolean;
  readonly publisherEnabled: boolean;
  readonly pendingReferenceEnabled: boolean;
  readonly pendingReferencePollMs: number;
  readonly pendingReferenceBatchSize: number;
  readonly eventQueueName: string;
  readonly concurrency: number;
  readonly sqsBatchSize: number;
  readonly longPollSeconds: number;
  readonly visibilitySeconds: number;
  readonly maxReceives: number;
  readonly retryBaseSeconds: number;
  readonly retryMaxSeconds: number;
  readonly externalTimeoutMs: number;
  readonly processingTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly outboxBatchSize: number;
  readonly outboxPollMs: number;
  readonly outboxRetryBaseMs: number;
  readonly outboxRetryMaxMs: number;
}

export function workerOptions(
  env: NodeJS.ProcessEnv = process.env,
): WorkerOptions {
  const integer = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const raw = env[name] ?? String(fallback);
    const value = Number(raw);
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    ) {
      throw new Error('Invalid ' + name);
    }
    return value;
  };
  const flag = (name: string, fallback: boolean): boolean => {
    const raw = env[name] ?? String(fallback);
    if (raw !== 'true' && raw !== 'false') {
      throw new Error('Invalid ' + name);
    }
    return raw === 'true';
  };
  const options = {
    httpEnabled: flag('HTTP_ENABLED', true),
    consumerEnabled: flag('SQS_CONSUMER_ENABLED', false),
    publisherEnabled: flag('OUTBOX_PUBLISHER_ENABLED', false),
    pendingReferenceEnabled: flag('PENDING_REFERENCE_WORKER_ENABLED', false),
    pendingReferencePollMs: integer(
      'PENDING_REFERENCE_POLL_INTERVAL_MS',
      1000,
      10,
      60000,
    ),
    pendingReferenceBatchSize: integer(
      'PENDING_REFERENCE_BATCH_SIZE',
      20,
      1,
      100,
    ),
    eventQueueName:
      env.SQS_EVENTS_QUEUE_NAME ?? 'wager-integration-events.fifo',
    concurrency: integer('SQS_CONSUMER_CONCURRENCY', 5, 1, 10),
    sqsBatchSize: integer('SQS_BATCH_SIZE', 10, 1, 10),
    longPollSeconds: integer('SQS_LONG_POLL_SECONDS', 20, 1, 20),
    visibilitySeconds: integer('SQS_VISIBILITY_TIMEOUT', 30, 5, 43200),
    maxReceives: integer('SQS_MAX_RECEIVE_COUNT', 5, 1, 100),
    retryBaseSeconds: integer('SQS_RETRY_BASE_SECONDS', 1, 1, 43200),
    retryMaxSeconds: integer('SQS_RETRY_MAX_SECONDS', 60, 1, 43200),
    externalTimeoutMs: integer('WORKER_EXTERNAL_TIMEOUT_MS', 3000, 100, 5000),
    processingTimeoutMs: integer(
      'WORKER_PROCESSING_TIMEOUT_MS',
      18000,
      1000,
      300000,
    ),
    shutdownTimeoutMs: integer(
      'WORKER_SHUTDOWN_TIMEOUT_MS',
      30000,
      11000,
      360000,
    ),
    outboxBatchSize: integer('OUTBOX_BATCH_SIZE', 20, 1, 100),
    outboxPollMs: integer('OUTBOX_POLL_INTERVAL_MS', 1000, 10, 60000),
    outboxRetryBaseMs: integer('OUTBOX_RETRY_BASE_MS', 1000, 1, 3600000),
    outboxRetryMaxMs: integer('OUTBOX_RETRY_MAX_MS', 60000, 1, 3600000),
  };
  if (
    options.eventQueueName ===
      (env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo') ||
    options.eventQueueName ===
      (env.SQS_DLQ_NAME ?? 'wager-transactions-dlq.fifo') ||
    (env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo') ===
      (env.SQS_DLQ_NAME ?? 'wager-transactions-dlq.fifo') ||
    options.eventQueueName.length > 80 ||
    !/^[A-Za-z0-9_-]+\.fifo$/.test(options.eventQueueName) ||
    options.retryBaseSeconds > options.retryMaxSeconds ||
    options.outboxRetryBaseMs > options.outboxRetryMaxMs ||
    options.processingTimeoutMs > shutdownDrainMs(options)
  ) {
    throw new Error('Invalid worker policy');
  }
  return Object.freeze(options);
}

export function shutdownDrainMs(
  options: Pick<WorkerOptions, 'shutdownTimeoutMs' | 'externalTimeoutMs'>,
): number {
  return Math.max(
    0,
    options.shutdownTimeoutMs -
      Math.max(10000, options.externalTimeoutMs * 2 + 5000),
  );
}
