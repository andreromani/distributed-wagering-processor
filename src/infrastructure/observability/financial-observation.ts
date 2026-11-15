import type { FinancialObserver } from '../../application/ports/financial-observer.js';
import { JsonLog } from './json-log.js';

export class FinancialObservationLogger implements FinancialObserver {
  constructor(private readonly log = new JsonLog()) {}

  record(
    event: string,
    fields: Readonly<Record<string, unknown>>,
    level: 'debug' | 'warn' | 'error',
  ): void {
    this.log.emit(level, event, fields);
  }
}
