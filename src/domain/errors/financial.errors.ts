import { FailureCode } from '../financial.types.js';

export class FinancialRuleError extends Error {
  constructor(public readonly code: FailureCode) {
    super(code);
    this.name = 'FinancialRuleError';
  }
}

export class InvalidTransactionStateError extends Error {
  constructor() {
    super('Transaction state does not allow this transition');
    this.name = 'InvalidTransactionStateError';
  }
}

export function timestamp(date: Date): number {
  const value = date.getTime();
  if (!Number.isFinite(value))
    throw new FinancialRuleError(FailureCode.InvalidTimestamp);
  return value;
}
