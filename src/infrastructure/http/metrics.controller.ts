import { Controller, Get, Header, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  SQSClient,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { OperationalMetrics } from '../observability/operational-metrics.js';
import { environment } from '../config/environment.js';
import { ensureDatabaseConnection } from '../database/database-connection.js';

@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(OperationalMetrics) private readonly metrics: OperationalMetrics,
    @Inject(DataSource) private readonly source: DataSource,
    @Inject(SQSClient) private readonly sqs: SQSClient,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async get(): Promise<string> {
    await Promise.all([this.collectDatabase(), this.collectSqs()]);
    return this.metrics.render();
  }

  private async collectDatabase(): Promise<void> {
    try {
      await ensureDatabaseConnection(this.source);
      const [row] = await this.source.query<
        { pending: string; lag: string; references: string }[]
      >(
        `SELECT count(*)::text AS pending,
          COALESCE(GREATEST(0, extract(epoch FROM now()-min(occurred_at))),0)::text AS lag,
          (SELECT count(*)::text FROM wager_transactions WHERE status='PENDING_REFERENCE') AS references
         FROM outbox_messages WHERE published_at IS NULL`,
      );
      const values = [row?.pending, row?.lag, row?.references].map(Number);
      if (!values.every((value) => Number.isFinite(value) && value >= 0)) {
        throw new Error('Invalid operational aggregates');
      }

      this.metrics.database(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0);
    } catch {
      this.metrics.databaseAvailable(false);
    }
  }

  private async collectSqs(): Promise<void> {
    try {
      const signal = AbortSignal.timeout(2500);
      const { QueueUrl } = await this.sqs.send(
        new GetQueueUrlCommand({ QueueName: environment().dlqName }),
        { abortSignal: signal },
      );
      const { Attributes } = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl,
          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
            'ApproximateNumberOfMessagesDelayed',
          ],
        }),
        { abortSignal: signal },
      );
      const counts = [
        Attributes?.ApproximateNumberOfMessages,
        Attributes?.ApproximateNumberOfMessagesNotVisible,
        Attributes?.ApproximateNumberOfMessagesDelayed,
      ].map((value) => Number(value ?? '0'));
      if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error('Invalid DLQ aggregate');
      }

      this.metrics.dlq(counts.reduce((sum, count) => sum + count, 0));
    } catch {
      this.metrics.sqsAvailable(false);
    }
  }
}
