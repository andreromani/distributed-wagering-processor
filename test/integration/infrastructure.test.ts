import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import {
  SQSClient,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module.js';
import { HealthController } from '../../src/infrastructure/http/health.controller.js';
import { environment } from '../../src/infrastructure/config/environment.js';

test('real infrastructure, DI, health, queue attributes and shutdown', async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  const database = app.get(DataSource);
  const sqs = app.get(SQSClient);
  try {
    await app.listen(0, '127.0.0.1');

    const url = await app.getUrl();
    for (const path of ['/health', '/health/live', '/health/ready']) {
      const response = await fetch(url + path);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    }

    expect(await database.query('SELECT 1 AS value')).toEqual([{ value: 1 }]);

    const config = environment();
    const main = await sqs.send(
      new GetQueueUrlCommand({ QueueName: config.queueName }),
    );
    const dlq = await sqs.send(
      new GetQueueUrlCommand({ QueueName: config.dlqName }),
    );
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: main.QueueUrl,
        AttributeNames: ['All'],
      }),
    );
    const dead = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlq.QueueUrl,
        AttributeNames: ['All'],
      }),
    );

    expect(attrs.Attributes?.FifoQueue).toBe('true');
    expect(dead.Attributes?.FifoQueue).toBe('true');
    expect(JSON.parse(attrs.Attributes?.RedrivePolicy ?? '{}')).toEqual({
      deadLetterTargetArn: dead.Attributes?.QueueArn,
      maxReceiveCount: Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5),
    });
    expect(attrs.Attributes?.VisibilityTimeout).toBe(
      process.env.SQS_VISIBILITY_TIMEOUT ?? '30',
    );
    expect(app.get(HealthController)).toBeInstanceOf(HealthController);
  } finally {
    await app.close();
  }

  expect(database.isInitialized).toBe(false);
}, 20000);

test('unavailable dependency gives 503 while liveness stays 200', async () => {
  const previous = process.env.SQS_ENDPOINT;
  process.env.SQS_ENDPOINT = 'http://127.0.0.1:1';

  const app = await NestFactory.create(AppModule, { logger: false });
  process.env.SQS_ENDPOINT = previous;
  try {
    await app.listen(0, '127.0.0.1');

    const url = await app.getUrl();

    expect((await fetch(url + '/health/live')).status).toBe(200);
    expect((await fetch(url + '/health/ready')).status).toBe(503);
  } finally {
    await app.close();
  }
}, 15000);
