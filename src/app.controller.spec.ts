import { expect, test } from 'bun:test';
import { AppController } from './app.controller.js';

test('health reports liveness', () => {
  expect(new AppController().health()).toEqual({ status: 'ok' });
});
