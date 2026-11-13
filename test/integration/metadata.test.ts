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

test('compiled financial DTOs retain nested validation metadata', async () => {
  const walletPath = '../../dist/infrastructure/http/dtos/create-wallet.dto.js';
  const moneyPath = '../../dist/infrastructure/http/dtos/money.dto.js';
  const wallet = await import(walletPath);
  const money = await import(moneyPath);

  expect(
    Reflect.getMetadata(
      'design:type',
      wallet.CreateWalletDto.prototype,
      'initialBalance',
    ),
  ).toBe(money.MoneyDto);
  expect(
    Reflect.getMetadata('design:type', money.MoneyDto.prototype, 'amount'),
  ).toBe(String);
});
