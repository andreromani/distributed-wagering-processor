import { AsyncLocalStorage } from 'node:async_hooks';
import type { FinancialContext } from '../../application/ports/financial-context.js';

export const transactionCancellation = new AsyncLocalStorage<AbortSignal>();

export function cancellableContext(
  context: FinancialContext,
  signal: AbortSignal,
): FinancialContext {
  const guard = <T extends object>(repository: T): T =>
    new Proxy(repository, {
      get(target, key, receiver): unknown {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== 'function') {
          return value;
        }
        return async (...args: unknown[]): Promise<unknown> => {
          signal.throwIfAborted();
          const result: unknown = await Reflect.apply(value, target, args);
          signal.throwIfAborted();
          return result;
        };
      },
    });
  return {
    wallets: guard(context.wallets),
    transactions: guard(context.transactions),
    ledger: guard(context.ledger),
    inbox: guard(context.inbox),
    outbox: guard(context.outbox),
  };
}
