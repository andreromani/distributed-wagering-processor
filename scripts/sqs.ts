import 'reflect-metadata';
import {
  SQSClient,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { environment } from '../src/infrastructure/config/environment.js';
import { parseWagerMessage } from '../src/infrastructure/messaging/consumers/parse-wager-message.js';

const config = environment();
const client = new SQSClient({
  ...config.sqs,
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 1000, requestTimeout: 4000 },
});
const [command, path] = Bun.argv.slice(2);
try {
  const name =
    command === 'dlq'
      ? config.dlqName
      : command === 'events'
        ? config.workers.eventQueueName
        : config.queueName;
  if (!['send', 'dlq', 'events', 'queues'].includes(command ?? '')) {
    throw new Error(
      'Usage: bun scripts/sqs.ts send message.json | dlq | events | queues',
    );
  }
  if (command === 'queues') {
    for (const QueueName of [
      config.queueName,
      config.dlqName,
      config.workers.eventQueueName,
    ]) {
      const { QueueUrl } = await client.send(
        new GetQueueUrlCommand({ QueueName }),
      );
      const state = await client.send(
        new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['All'] }),
      );
      console.log(
        JSON.stringify(
          { QueueName, QueueUrl, attributes: state.Attributes },
          null,
          2,
        ),
      );
    }
  } else {
    const { QueueUrl } = await client.send(
      new GetQueueUrlCommand({ QueueName: name }),
    );
    if (command === 'send') {
      if (!path) {
        throw new Error('A JSON file path is required');
      }
      const body = await Bun.file(path).text();
      const message = await parseWagerMessage(body);
      const sent = await client.send(
        new SendMessageCommand({
          QueueUrl,
          MessageBody: body,
          MessageGroupId: message.data.walletId,
          MessageDeduplicationId: crypto.randomUUID(),
        }),
      );
      console.log(
        JSON.stringify({
          businessMessageId: message.messageId,
          sqsMessageId: sent.MessageId,
        }),
      );
    } else {
      const messages = await client.send(
        new ReceiveMessageCommand({
          QueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 0,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['All'],
        }),
      );
      console.log(
        JSON.stringify(
          (messages.Messages ?? []).map((message) => ({
            sqsMessageId: message.MessageId,
            body: message.Body,
            attributes: message.MessageAttributes,
            systemAttributes: message.Attributes,
          })),
          null,
          2,
        ),
      );
    }
  }
} finally {
  client.destroy();
}
