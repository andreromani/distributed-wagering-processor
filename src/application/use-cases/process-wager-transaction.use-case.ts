import { inboxPayloadHash } from '../services/inbox-payload-hash.js';
import {
  observeFinancial,
  silentFinancialObserver,
  type FinancialObserver,
  type FinancialObservation,
} from '../ports/financial-observer.js';
import { InvalidMoneyAmountError } from '../../domain/errors/invalid-money-amount.error.js';
import { InvalidCurrencyError } from '../../domain/errors/invalid-currency.error.js';
import type { FinancialTransaction } from '../ports/financial-transaction.js';
import type {
  InboxRecord,
  FinancialContext,
} from '../ports/financial-context.js';
import {
  systemFinancialRuntime,
  type FinancialRuntime,
} from '../ports/financial-runtime.js';
import type { WagerPayload } from '../ports/wager-payload.js';
import { FinancialApplicationError } from '../errors/financial-application.error.js';
import { canonicalPayloadHash } from '../services/canonical-payload-hash.js';
import { withFinancialRetry } from '../services/financial-retry.js';
import {
  persistFinancialEvents,
  type EventContext,
} from '../services/financial-events.js';
import { Money, type MoneyProps } from '../../domain/value-objects/money.js';
import { MoneyOutOfRangeError } from '../../domain/errors/money-out-of-range.error.js';
import { FinancialRuleError } from '../../domain/errors/financial-rule.error.js';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '../../domain/entities/wager-transaction.js';
import type { Wallet } from '../../domain/entities/wallet.js';
import type { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.js';
import { InboxMessage } from '../../domain/entities/inbox-message.js';
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../domain/financial.types.js';
import type { StoredWager } from '../../domain/repositories/wager-transaction.repository.js';

export interface ProcessWagerInput extends WagerPayload, EventContext {
  idempotencyKey: string;
  inbox?: { consumerName: string; messageId: string };
}

export interface ProcessWagerResult {
  transactionId: string;
  status: Status;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  walletVersion?: number;
  referenceTransactionId?: string;
  createdAt: string;
  processedAt?: string;
  idempotentReplay: boolean;
  canAcknowledge: boolean;
}

export interface ReferenceRetryPolicy {
  maxAttempts: number;
  ttlMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const defaultReferenceRetryPolicy: Readonly<ReferenceRetryPolicy> =
  Object.freeze({
    maxAttempts: 5,
    ttlMs: 86400000,
    baseDelayMs: 1000,
    maxDelayMs: 60000,
  });

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly transaction: FinancialTransaction,
    private readonly runtime: FinancialRuntime = systemFinancialRuntime,
    private readonly policy: Readonly<ReferenceRetryPolicy> = defaultReferenceRetryPolicy,
    private readonly observer: FinancialObserver = silentFinancialObserver,
  ) {
    for (const value of Object.values(policy)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error('Invalid reference retry policy');
      }
    }
  }

  async execute(input: ProcessWagerInput): Promise<ProcessWagerResult> {
    const validated = this.validate(input);
    const messageHash = inboxPayloadHash(input);
    const observation: FinancialObservation = {
      observer: this.observer,
      fields: {
        operationId: validated.id,
        source: input.source ?? 'http',
        correlationId: input.correlationId,
        walletId: validated.walletId,
        providerId: validated.providerId,
        externalTransactionId: validated.externalTransactionId,
        kind: validated.kind,
      },
    };
    observeFinancial(observation, 'financial_processing_started');

    return withFinancialRetry(
      (sqlAttempt) =>
        this.transaction.run(
          async (context) => {
            const tx = WagerTransaction.create(validated);
            await this.checkInbox(context, input, messageHash);

            const previous = await this.existing(
              context,
              input,
              tx.payloadHash,
            );
            if (previous) {
              return this.replay(context, previous, input, messageHash);
            }

            const wallet = await context.wallets.findByIdForUpdate(
              input.walletId,
            );
            if (!wallet) {
              throw new FinancialApplicationError('WALLET_NOT_FOUND', tx.id);
            }

            const winner = await this.existing(context, input, tx.payloadHash);
            if (winner) {
              return this.replay(context, winner, input, messageHash);
            }

            this.assertWalletContext(wallet, tx);
            const stored = await this.settle(
              context,
              wallet,
              { transaction: tx, referenceAttempts: 0 },
              input,
              true,
            );
            await this.recordInbox(context, input, messageHash);

            return this.result(stored, false, input.inbox !== undefined);
          },
          { ...observation, fields: { ...observation.fields, sqlAttempt } },
        ),
      validated.id,
      undefined,
      observation,
    );
  }

  async reprocess(
    transactionId: string,
    metadata: EventContext = {},
  ): Promise<ProcessWagerResult> {
    const observation: FinancialObservation = {
      observer: this.observer,
      fields: {
        transactionId,
        correlationId: metadata.correlationId ?? transactionId,
        source: 'reference',
      },
    };
    observeFinancial(observation, 'financial_processing_started');
    return withFinancialRetry(
      (sqlAttempt) =>
        this.transaction.run(
          async (context) => {
            const initial = await context.transactions.findById(transactionId);
            if (!initial) {
              throw new FinancialApplicationError(
                'TRANSACTION_NOT_FOUND',
                transactionId,
              );
            }

            const wallet = await context.wallets.findByIdForUpdate(
              initial.transaction.walletId,
            );
            if (!wallet) {
              throw new FinancialApplicationError(
                'WALLET_NOT_FOUND',
                transactionId,
              );
            }

            const stored = await context.transactions.findById(transactionId);
            if (!stored) {
              throw new FinancialApplicationError(
                'TRANSACTION_NOT_FOUND',
                transactionId,
              );
            }

            if (stored.transaction.status !== Status.PendingReference) {
              return this.result(stored, true, false);
            }

            const at = this.runtime.now();
            if (
              stored.nextAttemptAt &&
              stored.nextAttemptAt > at &&
              at.getTime() - stored.transaction.createdAt.getTime() <
                this.policy.ttlMs
            ) {
              return this.result(stored, true, false);
            }

            const result = await this.settle(
              context,
              wallet,
              stored,
              metadata,
              false,
            );
            return this.result(result, false, false);
          },
          { ...observation, fields: { ...observation.fields, sqlAttempt } },
        ),
      transactionId,
      undefined,
      observation,
    );
  }

  private validate(input: ProcessWagerInput): CreateWagerTransactionProps {
    const identifiers = [
      input.providerId,
      input.externalTransactionId,
      input.idempotencyKey,
      input.walletId,
      input.playerId,
      input.roundId,
      input.gameId,
    ];
    if (
      identifiers.some((value) => typeof value !== 'string' || !value.trim())
    ) {
      throw new FinancialApplicationError('INVALID_INPUT');
    }

    if (
      input.providerId === 'internal' ||
      input.idempotencyKey.startsWith('opening:') ||
      input.kind === Kind.Opening
    ) {
      throw new FinancialApplicationError('INVALID_INPUT');
    }

    if (
      input.inbox &&
      [input.inbox.consumerName, input.inbox.messageId].some(
        (value) => typeof value !== 'string' || !value.trim(),
      )
    ) {
      throw new FinancialApplicationError('INVALID_INPUT');
    }

    if (
      input.referenceExternalTransactionId !== undefined &&
      (typeof input.referenceExternalTransactionId !== 'string' ||
        !input.referenceExternalTransactionId.trim() ||
        ![Kind.Win, Kind.Refund, Kind.Rollback].includes(input.kind))
    ) {
      throw new FinancialApplicationError('INVALID_INPUT');
    }

    let money: Money;
    try {
      money = Money.from(input.money);
    } catch (error) {
      if (
        error instanceof InvalidMoneyAmountError ||
        error instanceof InvalidCurrencyError ||
        error instanceof MoneyOutOfRangeError
      ) {
        throw new FinancialApplicationError('INVALID_INPUT');
      }
      throw error;
    }

    const props: CreateWagerTransactionProps = {
      id: this.runtime.id(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: this.runtime.now(),
      payloadHash: canonicalPayloadHash(input),
    };

    try {
      WagerTransaction.create(props);
    } catch (error) {
      if (error instanceof FinancialRuleError) {
        throw new FinancialApplicationError('INVALID_INPUT');
      }
      throw error;
    }

    return props;
  }

  private assertWalletContext(wallet: Wallet, tx: WagerTransaction): void {
    if (
      wallet.playerId !== tx.playerId ||
      wallet.currency !== tx.money.currency
    ) {
      throw new FinancialApplicationError('CONTEXT_MISMATCH', tx.id);
    }
  }

  private async checkInbox(
    context: FinancialContext,
    input: ProcessWagerInput,
    hash: string,
  ): Promise<InboxRecord | undefined> {
    if (!input.inbox) {
      return undefined;
    }

    const record = await context.inbox.find(
      input.inbox.consumerName,
      input.inbox.messageId,
    );
    if (record && record.payloadHash !== hash) {
      throw new FinancialApplicationError('INBOX_CONFLICT');
    }

    return record;
  }

  private async recordInbox(
    context: FinancialContext,
    input: ProcessWagerInput,
    hash: string,
  ): Promise<void> {
    if (!input.inbox) {
      return;
    }

    const record = await this.checkInbox(context, input, hash);
    if (record) {
      const existing = InboxMessage.rehydrate(record);
      if (!existing.isProcessed()) {
        existing.markProcessed(this.runtime.now());
        await context.inbox.markProcessed(
          existing.consumerName,
          existing.messageId,
          existing.processedAt ?? this.runtime.now(),
        );
      }
      return;
    }

    const message = InboxMessage.receive({
      ...input.inbox,
      payloadHash: hash,
      receivedAt: this.runtime.now(),
    });
    message.markProcessed(this.runtime.now());
    await context.inbox.insert(message);
  }

  private async existing(
    context: FinancialContext,
    input: ProcessWagerInput,
    hash: string,
  ): Promise<StoredWager | undefined> {
    const previous =
      (await context.transactions.findByIdempotencyKey(input.idempotencyKey)) ??
      (await context.transactions.findByProviderExternal(
        input.providerId,
        input.externalTransactionId,
      ));
    if (!previous) {
      return undefined;
    }

    if (previous.transaction.idempotencyKey !== input.idempotencyKey) {
      throw new FinancialApplicationError(
        'EXTERNAL_IDENTITY_CONFLICT',
        previous.transaction.id,
      );
    }

    if (!previous.transaction.matchesPayload(hash)) {
      throw new FinancialApplicationError(
        'IDEMPOTENCY_CONFLICT',
        previous.transaction.id,
      );
    }

    return previous;
  }

  private async replay(
    context: FinancialContext,
    stored: StoredWager,
    input: ProcessWagerInput,
    hash: string,
  ): Promise<ProcessWagerResult> {
    await this.recordInbox(context, input, hash);

    return this.result(stored, true, input.inbox !== undefined);
  }

  private async settle(
    context: FinancialContext,
    wallet: Wallet,
    stored: StoredWager,
    metadata: EventContext,
    inserting: boolean,
  ): Promise<StoredWager> {
    const tx = stored.transaction;
    const previousStatus = tx.status;
    const at = this.runtime.now();
    let entry: WalletLedgerEntry | undefined;
    let referenceAttempts = stored.referenceAttempts;
    let nextAttemptAt: Date | undefined;

    try {
      if (
        !inserting &&
        (at.getTime() - tx.createdAt.getTime() >= this.policy.ttlMs ||
          stored.referenceAttempts >= this.policy.maxAttempts)
      ) {
        throw new FinancialRuleError(FailureCode.ReferenceNotFound);
      }

      const reference =
        tx.referenceExternalTransactionId === undefined
          ? undefined
          : await context.transactions.findReference(
              tx.providerId,
              tx.referenceExternalTransactionId,
            );
      const resolved = reference?.transaction;
      if (tx.referenceExternalTransactionId) {
        observeFinancial(
          {
            observer: this.observer,
            fields: {
              ...(inserting
                ? { operationId: tx.id }
                : { transactionId: tx.id }),
              walletId: wallet.id,
              providerId: tx.providerId,
              correlationId: metadata.correlationId ?? tx.id,
              source: metadata.source ?? (inserting ? 'http' : 'reference'),
            },
          },
          resolved
            ? 'financial_reference_found'
            : 'financial_reference_missing',
          {
            referenceExternalTransactionId: tx.referenceExternalTransactionId,
            referenceTransactionId: resolved?.id,
            referenceStatus: resolved?.status,
          },
        );
      }
      if (
        resolved?.status === Status.Processed &&
        tx.requiresReference() &&
        (await context.transactions.findProcessedReversal(resolved.id, tx.kind))
      ) {
        throw new FinancialRuleError(FailureCode.InvalidReference);
      }

      entry = tx.applyTo(
        wallet,
        { ledgerEntryId: this.runtime.id(), at },
        resolved,
      );

      if (tx.status === Status.PendingReference) {
        referenceAttempts += 1;
        if (referenceAttempts >= this.policy.maxAttempts) {
          tx.reject(FailureCode.ReferenceNotFound);
        } else {
          nextAttemptAt = new Date(
            at.getTime() +
              Math.min(
                this.policy.baseDelayMs * 2 ** (referenceAttempts - 1),
                this.policy.maxDelayMs,
              ),
          );
        }
      }
    } catch (error) {
      if (error instanceof FinancialRuleError) {
        observeFinancial(
          {
            observer: this.observer,
            fields: {
              ...(inserting
                ? { operationId: tx.id }
                : { transactionId: tx.id }),
              walletId: wallet.id,
              providerId: tx.providerId,
              correlationId: metadata.correlationId ?? tx.id,
              source: metadata.source ?? (inserting ? 'http' : 'reference'),
            },
          },
          error.code.includes('REFERENCE')
            ? 'financial_reference_invalid'
            : 'financial_rule_rejected',
          {
            failureCode: error.code,
            referenceExternalTransactionId: tx.referenceExternalTransactionId,
          },
        );
        tx.reject(error.code);
      } else if (error instanceof MoneyOutOfRangeError) {
        tx.reject(FailureCode.InvalidAmount);
      } else {
        throw error;
      }
    }

    const result = tx.isTerminal()
      ? { balance: wallet.balance, version: wallet.version }
      : undefined;
    if (inserting) {
      await context.transactions.insert(tx, result, {
        referenceAttempts,
        nextAttemptAt,
      });
    }
    if (!inserting) {
      await context.transactions.update(tx, {
        result,
        referenceAttempts,
        nextAttemptAt: nextAttemptAt ?? null,
      });
    }

    if (entry) {
      await context.wallets.update(wallet);
      await context.ledger.insert(entry);
    }

    if (inserting || tx.status !== previousStatus) {
      await persistFinancialEvents(
        context,
        tx,
        wallet,
        entry,
        metadata,
        at,
        this.runtime,
      );
    }

    return { transaction: tx, result, referenceAttempts, nextAttemptAt };
  }

  private result(
    stored: StoredWager,
    replay: boolean,
    acknowledge: boolean,
  ): ProcessWagerResult {
    const tx = stored.transaction;
    return {
      transactionId: tx.id,
      status: tx.status,
      ...(tx.failureCode === undefined ? {} : { failureCode: tx.failureCode }),
      ...(stored.result
        ? {
            balance: stored.result.balance.toJSON(),
            walletVersion: stored.result.version,
          }
        : {}),
      ...(tx.referenceTransactionId === undefined
        ? {}
        : { referenceTransactionId: tx.referenceTransactionId }),
      createdAt: tx.createdAt.toISOString(),
      ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
      idempotentReplay: replay,
      canAcknowledge: acknowledge,
    };
  }
}
