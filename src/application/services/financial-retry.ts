import { PersistenceError } from '../ports/persistence.error.js';
import { FinancialApplicationError } from '../errors/financial-application.error.js';

const retryConstraints = new Set([
  'uq_wager_idempotency',
  'uq_wager_provider_external',
  'uq_wager_processed_reversal',
  'inbox_messages_pkey',
]);

export async function withFinancialRetry<T>(
  work: () => Promise<T>,
  operationId?: string,
  wait: (milliseconds: number) => Promise<unknown> = Bun.sleep,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await work();
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
