import { FailureCode } from '../financial.types.js';

export class FinancialRuleError extends Error {
  constructor(public readonly code: FailureCode) {
    super(code);
    this.name = 'FinancialRuleError';
  }
}
