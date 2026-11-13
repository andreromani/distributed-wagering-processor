import { FinancialApplicationError } from '../../../application/errors/financial-application.error.js';
import { PersistenceError } from '../../../application/ports/persistence.error.js';
import { InvalidWagerMessageError } from './invalid-wager-message.error.js';

export function classifyMessageError(error: unknown): {
  kind: 'permanent' | 'transient';
  code: string;
} {
  if (error instanceof InvalidWagerMessageError) {
    return { kind: 'permanent', code: 'INVALID_MESSAGE' };
  }
  if (error instanceof FinancialApplicationError) {
    return {
      kind: ['TRANSIENT_FAILURE', 'WALLET_NOT_FOUND'].includes(error.code)
        ? 'transient'
        : 'permanent',
      code: error.code,
    };
  }
  if (error instanceof PersistenceError) {
    return {
      kind:
        error.category === 'permanent' || error.category === 'unique'
          ? 'permanent'
          : 'transient',
      code:
        error.category === 'transient'
          ? 'TRANSIENT_FAILURE'
          : 'PERMANENT_FAILURE',
    };
  }
  return { kind: 'transient', code: 'UNCLASSIFIED_FAILURE' };
}
