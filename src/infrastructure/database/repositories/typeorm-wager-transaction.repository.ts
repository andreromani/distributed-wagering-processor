import { EntityManager } from 'typeorm';
import type { WagerTransaction } from '../../../domain/entities/wager-transaction.js';
import { Money } from '../../../domain/value-objects/money.js';
import {
  WagerTransactionStatus,
  WagerTransactionKind,
} from '../../../domain/financial.types.js';
import type {
  WagerTransactionRepository,
  OriginalResult,
  StoredWager,
} from '../../../domain/repositories/wager-transaction.repository.js';
import {
  WagerRowSchema,
  type WagerRow,
} from '../entities/wager-transaction.schema.js';
import {
  wagerToRow,
  wagerFromRow,
} from '../mappers/wager-transaction.mapper.js';
import { requireTransaction } from './transaction-context.js';

function stored(row: WagerRow | null): StoredWager | undefined {
  if (!row) {
    return undefined;
  }

  return {
    transaction: wagerFromRow(row),
    referenceAttempts: row.reference_attempts,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    result:
      row.result_balance === null || row.result_version === null
        ? undefined
        : {
            balance: Money.rehydrate({
              amount: row.result_balance,
              currency: row.currency,
            }),
            version: row.result_version,
          },
  };
}

function snapshot(transaction: WagerTransaction, result?: OriginalResult) {
  if (result && result.balance.currency !== transaction.money.currency) {
    throw new Error('Snapshot currency mismatch');
  }

  return {
    result_balance: result?.balance.toString() ?? null,
    result_version: result?.version ?? null,
  };
}

export class TypeOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly manager: EntityManager) {}

  async insert(
    transaction: WagerTransaction,
    result?: OriginalResult,
  ): Promise<void> {
    requireTransaction(this.manager);

    await this.manager.insert(WagerRowSchema, {
      ...wagerToRow(transaction),
      ...snapshot(transaction, result),
    });
  }

  async findById(id: string) {
    return stored(await this.manager.findOneBy(WagerRowSchema, { id }));
  }

  async findByProviderExternal(providerId: string, externalId: string) {
    return stored(
      await this.manager.findOneBy(WagerRowSchema, {
        provider_id: providerId,
        external_transaction_id: externalId,
      }),
    );
  }

  async findReference(providerId: string, externalId: string) {
    return this.findByProviderExternal(providerId, externalId);
  }

  async findByIdempotencyKey(key: string) {
    return stored(
      await this.manager.findOneBy(WagerRowSchema, { idempotency_key: key }),
    );
  }

  async findProcessedReversal(referenceId: string, kind: WagerTransactionKind) {
    return stored(
      await this.manager.findOneBy(WagerRowSchema, {
        reference_transaction_id: referenceId,
        kind,
        status: WagerTransactionStatus.Processed,
      }),
    );
  }

  async update(
    transaction: WagerTransaction,
    options: {
      result?: OriginalResult;
      referenceAttempts?: number;
      nextAttemptAt?: Date;
    } = {},
  ): Promise<void> {
    requireTransaction(this.manager);

    const row = wagerToRow(transaction);
    const result = await this.manager.update(
      WagerRowSchema,
      { id: transaction.id },
      {
        status: row.status,
        reference_transaction_id: row.reference_transaction_id,
        failure_code: row.failure_code,
        processed_at: row.processed_at,
        ...snapshot(transaction, options.result),
        ...(options.referenceAttempts === undefined
          ? {}
          : { reference_attempts: options.referenceAttempts }),
        ...(options.nextAttemptAt === undefined
          ? {}
          : { next_attempt_at: options.nextAttemptAt }),
      },
    );

    if (result.affected !== 1) {
      throw new Error('Transaction not found');
    }
  }
}
