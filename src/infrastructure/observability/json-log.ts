import { instanceId } from '../config/instance-id.js';
import { logLevel, type LogLevel } from '../config/log-level.js';

export type LogSink = (record: Readonly<Record<string, unknown>>) => void;
const ranks: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};
const allowed = new Set([
  'message',
  'source',
  'correlationId',
  'causationId',
  'messageId',
  'sqsMessageId',
  'transactionId',
  'operationId',
  'walletId',
  'providerId',
  'externalTransactionId',
  'kind',
  'status',
  'failureCode',
  'code',
  'statusCode',
  'idempotentReplay',
  'attempt',
  'sqlAttempt',
  'durationMs',
  'eventId',
  'eventType',
  'consumerName',
  'delaySeconds',
  'delayMs',
  'nextAttemptAt',
  'stage',
  'signal',
  'databaseConnected',
  'runId',
  'point',
  'id',
  'pid',
  'reachedAt',
  'referenceExternalTransactionId',
  'referenceTransactionId',
  'referenceStatus',
  'errorCategory',
]);

/** Local stdout only. Logging must never change an operation's outcome. */
export class JsonLog {
  constructor(
    private readonly sink: LogSink = (record) =>
      console.log(JSON.stringify(record)),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  emit(
    level: LogLevel,
    event: string,
    fields: Readonly<Record<string, unknown>> = {},
  ): void {
    try {
      if (ranks[level] < ranks[logLevel(this.env)]) {
        return;
      }

      const safe: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (
          allowed.has(key) &&
          (typeof value === 'string' ||
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value)))
        ) {
          safe[key] = value;
        }
      }

      this.sink({
        ...safe,
        timestamp: new Date().toISOString(),
        level,
        event,
        instanceId: instanceId(this.env),
      });
    } catch {
      // No fallback logger: it could throw too or expose an unsanitized error.
    }
  }
}
