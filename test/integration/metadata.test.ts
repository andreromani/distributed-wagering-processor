import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { DataSource } from 'typeorm';
import { SQSClient } from '@aws-sdk/client-sqs';
test('compiled decorators retain constructor metadata', async () => {
  const path = '../../dist/infrastructure/http/health.controller.js';
  const compiled = await import(path);
  expect(
    Reflect.getMetadata('design:paramtypes', compiled.HealthController),
  ).toEqual([DataSource, SQSClient]);
});
