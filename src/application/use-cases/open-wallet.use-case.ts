import type { FinancialTransaction } from '../ports/financial-transaction.js';
import {
  systemFinancialRuntime,
  type FinancialRuntime,
} from '../ports/financial-runtime.js';
import type { EventContext } from '../services/financial-events.js';
import { persistFinancialEvents } from '../services/financial-events.js';
import { FinancialApplicationError } from '../errors/financial-application.error.js';
import { PersistenceError } from '../ports/persistence.error.js';
import { withFinancialRetry } from '../services/financial-retry.js';
import { Wallet } from '../../domain/entities/wallet.js';
import { Money, type MoneyProps } from '../../domain/value-objects/money.js';
import { canonicalJson } from '../services/canonical-payload-hash.js';
import { createHash } from 'node:crypto';
import {
  observeFinancial,
  silentFinancialObserver,
  type FinancialObserver,
  type FinancialObservation,
} from '../ports/financial-observer.js';

export interface OpenWalletInput extends EventContext {
  playerId: string;
  initialBalance: MoneyProps;
}
export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class OpenWalletUseCase {
  constructor(
    private readonly transaction: FinancialTransaction,
    private readonly runtime: FinancialRuntime = systemFinancialRuntime,
    private readonly observer: FinancialObserver = silentFinancialObserver,
  ) {}

  async execute(input: OpenWalletInput): Promise<OpenWalletResult> {
    if (typeof input.playerId !== 'string' || !input.playerId.trim()) {
      throw new FinancialApplicationError('INVALID_INPUT');
    }

    let initialBalance: Money;
    try {
      initialBalance = Money.from(input.initialBalance);
    } catch {
      throw new FinancialApplicationError('INVALID_INPUT');
    }

    const observation: FinancialObservation = {
      observer: this.observer,
      fields: {
        source: 'http',
        correlationId: input.correlationId,
        kind: initialBalance.isPositive() ? 'OPENING' : undefined,
      },
    };
    observeFinancial(observation, 'financial_processing_started');
    try {
      return await withFinancialRetry(
        (sqlAttempt) =>
          this.transaction.run(
            async (context) => {
              const at = this.runtime.now();
              const walletId = this.runtime.id();
              const result = Wallet.open({
                id: walletId,
                playerId: input.playerId,
                initialBalance,
                at,
                opening: {
                  transactionId: this.runtime.id(),
                  ledgerEntryId: this.runtime.id(),
                  payloadHash: createHash('sha256')
                    .update(
                      canonicalJson({
                        playerId: input.playerId,
                        initialBalance: initialBalance.toJSON(),
                      }),
                    )
                    .digest('hex'),
                },
              });

              await context.wallets.insert(result.wallet);

              if (result.openingTransaction && result.openingEntry) {
                await context.transactions.insert(result.openingTransaction, {
                  balance: result.wallet.balance,
                  version: 1,
                });
                await context.ledger.insert(result.openingEntry);
                await persistFinancialEvents(
                  context,
                  result.openingTransaction,
                  result.wallet,
                  result.openingEntry,
                  input,
                  at,
                  this.runtime,
                );
              }

              return {
                id: result.wallet.id,
                playerId: result.wallet.playerId,
                balance: result.wallet.balance.toJSON(),
                version: result.wallet.version,
              };
            },
            { ...observation, fields: { ...observation.fields, sqlAttempt } },
          ),
        undefined,
        undefined,
        observation,
      );
    } catch (error) {
      if (
        error instanceof PersistenceError &&
        error.constraint === 'uq_wallet_player_currency'
      ) {
        throw new FinancialApplicationError('WALLET_CONFLICT');
      }
      throw error;
    }
  }
}
