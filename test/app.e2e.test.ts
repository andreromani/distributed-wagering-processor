import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';

test('GET /health returns HTTP 200 and JSON', async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ status: 'ok' });
  } finally {
    await app.close();
  }
});
