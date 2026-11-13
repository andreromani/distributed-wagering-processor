import {
  SQSClient,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { createHash } from 'node:crypto';
import type { WorkerOptions } from '../../config/worker-options.js';
import type { WagerQueue, WagerDelivery } from './wager-queue.js';
import type { IntegrationEventPublisher } from '../../../application/ports/integration-event-publisher.js';
import type { OutboxMessage } from '../../../domain/entities/outbox-message.js';

export class SqsTransport implements WagerQueue, IntegrationEventPublisher {
  readonly #urls = new Map<string, Promise<string>>();

  constructor(
    private readonly client: SQSClient,
    private readonly names: { queueName: string; dlqName: string },
    private readonly options: WorkerOptions,
  ) {
    if (
      options.eventQueueName === names.queueName ||
      options.eventQueueName === names.dlqName ||
      names.queueName === names.dlqName
    ) {
      throw new Error(
        'Input, DLQ and integration event queues must be distinct',
      );
    }
  }

  private url(name: string): Promise<string> {
    const existing = this.#urls.get(name);
    if (existing) {
      return existing;
    }
    const loading = this.client
      .send(new GetQueueUrlCommand({ QueueName: name }), {
        abortSignal: AbortSignal.timeout(this.options.externalTimeoutMs),
      })
      .then((result) => {
        if (!result.QueueUrl) {
          throw new Error('Queue URL unavailable');
        }
        return result.QueueUrl;
      })
      .catch((error: unknown) => {
        this.#urls.delete(name);
        throw error;
      });
    this.#urls.set(name, loading);
    return loading;
  }

  async verify(): Promise<void> {
    const [source, dlq] = await Promise.all([
      this.url(this.names.queueName),
      this.url(this.names.dlqName),
    ]);
    const [attributes, dead] = await Promise.all([
      this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: source,
          AttributeNames: ['FifoQueue', 'RedrivePolicy'],
        }),
        { abortSignal: AbortSignal.timeout(this.options.externalTimeoutMs) },
      ),
      this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: dlq,
          AttributeNames: ['QueueArn', 'FifoQueue'],
        }),
        { abortSignal: AbortSignal.timeout(this.options.externalTimeoutMs) },
      ),
    ]);
    const redrive: unknown = JSON.parse(
      attributes.Attributes?.RedrivePolicy ?? '{}',
    );
    if (
      attributes.Attributes?.FifoQueue !== 'true' ||
      dead.Attributes?.FifoQueue !== 'true' ||
      !redrive ||
      typeof redrive !== 'object' ||
      !('maxReceiveCount' in redrive) ||
      Number(redrive.maxReceiveCount) !== this.options.maxReceives ||
      !('deadLetterTargetArn' in redrive) ||
      redrive.deadLetterTargetArn !== dead.Attributes?.QueueArn
    ) {
      throw new Error(
        'Queue redrive policy does not match worker configuration',
      );
    }
  }

  async receive(
    maximum: number,
    signal: AbortSignal,
  ): Promise<WagerDelivery[]> {
    const QueueUrl = await this.url(this.names.queueName);
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl,
        WaitTimeSeconds: this.options.longPollSeconds,
        MaxNumberOfMessages: maximum,
        VisibilityTimeout: this.options.visibilitySeconds,
        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
          'MessageGroupId',
        ],
      }),
      {
        abortSignal: AbortSignal.any([
          signal,
          AbortSignal.timeout(
            this.options.longPollSeconds * 1000 +
              this.options.externalTimeoutMs,
          ),
        ]),
      },
    );
    return (result.Messages ?? []).map((message) => {
      if (
        !message.MessageId ||
        !message.ReceiptHandle ||
        !message.Attributes?.MessageGroupId
      ) {
        throw new Error('Incomplete SQS delivery metadata');
      }
      const receiveCount = Number(message.Attributes.ApproximateReceiveCount);
      if (!Number.isSafeInteger(receiveCount) || receiveCount < 1) {
        throw new Error('Invalid receive count');
      }
      return {
        body: message.Body ?? '',
        sqsMessageId: message.MessageId,
        receiptHandle: message.ReceiptHandle,
        groupId: message.Attributes.MessageGroupId,
        receiveCount,
      };
    });
  }

  async acknowledge(message: WagerDelivery): Promise<void> {
    const QueueUrl = await this.url(this.names.queueName);
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl,
        ReceiptHandle: message.receiptHandle,
      }),
      { abortSignal: AbortSignal.timeout(this.options.externalTimeoutMs) },
    );
  }

  async visibility(message: WagerDelivery, seconds: number): Promise<void> {
    const QueueUrl = await this.url(this.names.queueName);
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl,
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: seconds,
      }),
      { abortSignal: AbortSignal.timeout(this.options.externalTimeoutMs) },
    );
  }

  async deadLetter(
    message: WagerDelivery,
    failureCode: string,
    businessMessageId?: string,
  ): Promise<void> {
    const QueueUrl = await this.url(this.names.dlqName);
    const confirmation = await this.client.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: message.body,
        MessageGroupId: message.groupId,
        MessageDeduplicationId: createHash('sha256')
          .update(message.sqsMessageId)
          .digest('hex'),
        MessageAttributes: {
          failureCode: { DataType: 'String', StringValue: failureCode },
          originalSqsMessageId: {
            DataType: 'String',
            StringValue: message.sqsMessageId,
          },
          receiveCount: {
            DataType: 'Number',
            StringValue: String(message.receiveCount),
          },
          ...(businessMessageId
            ? {
                businessMessageId: {
                  DataType: 'String',
                  StringValue: businessMessageId,
                },
              }
            : {}),
        },
      }),
      { abortSignal: AbortSignal.timeout(this.options.externalTimeoutMs) },
    );
    if (!confirmation.MessageId) {
      throw new Error('DLQ send confirmation missing');
    }
  }

  async publish(
    event: OutboxMessage,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const QueueUrl = await this.url(this.options.eventQueueName);
    const confirmation = await this.client.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: JSON.stringify(event.payload),
        MessageGroupId: event.aggregateId,
        MessageDeduplicationId: event.id,
      }),
      {
        abortSignal: AbortSignal.any([
          signal,
          AbortSignal.timeout(this.options.externalTimeoutMs),
        ]),
      },
    );
    if (!confirmation.MessageId) {
      throw new Error('Event send confirmation missing');
    }
  }
}
