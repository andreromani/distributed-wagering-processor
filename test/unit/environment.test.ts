import { test, expect } from 'bun:test';
import { environment } from '../../src/infrastructure/config/environment.js';

test('configuration rejects missing and invalid variables', () => {
  expect(() => environment({})).toThrow();
  expect(() =>
    environment({ ...process.env, POSTGRES_PORT: 'invalid' }),
  ).toThrow();
});
