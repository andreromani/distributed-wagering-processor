import { FailureCode } from '../financial.types.js';
import { FinancialRuleError } from './financial-rule.error.js';

export function timestamp(date: Date): number {
  const value = date.getTime();
  if (!Number.isFinite(value))
    throw new FinancialRuleError(FailureCode.InvalidTimestamp);

  return value;
}
