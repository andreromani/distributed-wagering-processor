import { ensureDatabaseConnection } from '../database/database-connection.js';
import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  SQSClient,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { environment } from '../config/environment.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DataSource) private readonly database: DataSource,
    @Inject(SQSClient) private readonly sqs: SQSClient,
  ) {}

  @Get(['', 'live'])
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    try {
      await Promise.all([this.checkDatabase(), this.checkSqs()]);

      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
  }

  private async checkDatabase() {
    await ensureDatabaseConnection(this.database);

    await this.database.query('SELECT 1');
  }

  private async checkSqs() {
    const config = environment();
    const queues = [config.queueName, config.dlqName];
    if (config.workers.publisherEnabled) {
      queues.push(config.workers.eventQueueName);
    }
    for (const QueueName of queues) {
      const { QueueUrl } = await this.sqs.send(
        new GetQueueUrlCommand({ QueueName }),
        { abortSignal: AbortSignal.timeout(2500) },
      );
      const { Attributes } = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl,
          AttributeNames: ['FifoQueue'],
        }),
        { abortSignal: AbortSignal.timeout(2500) },
      );

      if (Attributes?.FifoQueue !== 'true') {
        throw new Error('Queue not ready');
      }
    }
  }
}
