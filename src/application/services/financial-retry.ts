import { PersistenceError } from '../ports/persistence.error.js';
import { FinancialApplicationError } from '../errors/financial-application.error.js';
import {
  observeFinancial,
  type FinancialObservation,
} from '../ports/financial-observer.js';

const retryConstraints = new Set([
  'uq_wager_idempotency',
  'uq_wager_provider_external',
  'uq_wager_processed_reversal',
  'inbox_messages_pkey',
]);

export async function withFinancialRetry<T>(
  work: (sqlAttempt: number) => Promise<T>,
  operationId?: string,
  wait: (milliseconds: number) => Promise<unknown> = Bun.sleep,
  observation?: FinancialObservation,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      observeFinancial(observation, 'financial_attempt_started', {
        sqlAttempt: attempt + 1,
      });
      return await work(attempt + 1);
    } catch (error) {
      if (!(error instanceof PersistenceError)) {
        throw error;
      }

      if (
        error.category === 'unique' &&
        error.constraint === 'uq_wallet_player_currency'
      ) {
        throw error;
      }

      const retryable =
        error.category === 'transient' ||
        (error.category === 'unique' &&
          retryConstraints.has(error.constraint ?? ''));
      if (retryable && attempt < 2) {
        observeFinancial(
          observation,
          'financial_retry_scheduled',
          {
            sqlAttempt: attempt + 1,
            delayMs:
              error.category === 'transient'
                ? Math.min(25 * 2 ** attempt, 100)
                : 0,
            errorCategory: error.category,
            failureCode:
              error.category === 'transient'
                ? 'TRANSIENT_FAILURE'
                : 'IDENTITY_RACE',
          },
          'warn',
        );
        if (error.category === 'transient') {
          await wait(Math.min(25 * 2 ** attempt, 100));
        }

        continue;
      }

      throw new FinancialApplicationError(
        retryable ? 'TRANSIENT_FAILURE' : 'PERMANENT_FAILURE',
        operationId,
      );
    }
  }

  throw new FinancialApplicationError('TRANSIENT_FAILURE', operationId);
}
