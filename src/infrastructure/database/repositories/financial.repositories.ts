import { DataSource, EntityManager } from 'typeorm';
import type { Wallet } from '../../../domain/entities/wallet.js';
import type { WagerTransaction } from '../../../domain/entities/wager-transaction.js';
import type { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.js';
import { Money } from '../../../domain/value-objects/money.js';
import {
  WagerTransactionStatus,
  WagerTransactionKind,
} from '../../../domain/financial.types.js';
import type {
  WalletRepository,
  WagerTransactionRepository,
  LedgerRepository,
  OriginalResult,
  StoredWager,
} from '../../../domain/repositories/financial.repositories.js';
import type {
  FinancialTransaction,
  FinancialContext,
  InboxRecord,
  OutboxRecord,
} from '../../../application/ports/financial-transaction.js';
import {
  WalletRowSchema,
  WagerRowSchema,
  LedgerRowSchema,
  InboxRowSchema,
  OutboxRowSchema,
  type WagerRow,
} from '../entities/financial.schemas.js';
import {
  walletToRow,
  walletFromRow,
  wagerToRow,
  wagerFromRow,
  ledgerToRow,
  ledgerFromRow,
} from '../mappers/financial.mappers.js';
import { requireTransaction } from './transaction-context.js';

export class TypeOrmWalletRepository implements WalletRepository {
  constructor(private readonly manager: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    requireTransaction(this.manager);
    await this.manager.insert(WalletRowSchema, walletToRow(wallet));
  }

  async findById(id: string) {
    const row = await this.manager.findOneBy(WalletRowSchema, { id });
    return row ? walletFromRow(row) : undefined;
  }

  async findByPlayerCurrency(playerId: string, currency: string) {
    const row = await this.manager.findOneBy(WalletRowSchema, {
      player_id: playerId,
      currency,
    });
    return row ? walletFromRow(row) : undefined;
  }

  async findByIdForUpdate(id: string) {
    requireTransaction(this.manager);
    const row = await this.manager.findOne(WalletRowSchema, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    return row ? walletFromRow(row) : undefined;
  }

  async update(wallet: Wallet): Promise<void> {
    requireTransaction(this.manager);
    const result = await this.manager.update(
      WalletRowSchema,
      { id: wallet.id },
      {
        balance: wallet.balance.toString(),
        version: wallet.version,
        updated_at: wallet.updatedAt,
      },
    );
    if (result.affected !== 1) throw new Error('Wallet not found');
  }
}

function stored(row: WagerRow | null): StoredWager | undefined {
  if (!row) return undefined;
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
  if (result && result.balance.currency !== transaction.money.currency)
    throw new Error('Snapshot currency mismatch');
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
    if (result.affected !== 1) throw new Error('Transaction not found');
  }
}

export class TypeOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly manager: EntityManager) {}
  async insert(entry: WalletLedgerEntry): Promise<void> {
    requireTransaction(this.manager);
    await this.manager.insert(LedgerRowSchema, ledgerToRow(entry));
  }
  async findByWallet(
    walletId: string,
    limit = 50,
    after?: { createdAt: Date; id: string },
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Invalid ledger limit');
    const query = this.manager
      .createQueryBuilder(LedgerRowSchema, 'entry')
      .where('entry.wallet_id = :walletId', { walletId });
    if (after)
      query.andWhere('(entry.created_at, entry.id) > (:createdAt, :id)', after);
    const rows = await query
      .orderBy('entry.created_at', 'ASC')
      .addOrderBy('entry.id', 'ASC')
      .take(limit)
      .getMany();
    return rows.map(ledgerFromRow);
  }
}

export class TypeOrmInboxRepository {
  constructor(private readonly manager: EntityManager) {}
  async insert(message: InboxRecord): Promise<void> {
    requireTransaction(this.manager);
    await this.manager.insert(InboxRowSchema, {
      consumer_name: message.consumerName,
      message_id: message.messageId,
      payload_hash: message.payloadHash,
      received_at: message.receivedAt,
      processed_at: message.processedAt ?? null,
    });
  }
  async find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxRecord | undefined> {
    const row = await this.manager.findOneBy(InboxRowSchema, {
      consumer_name: consumerName,
      message_id: messageId,
    });
    return row
      ? {
          consumerName: row.consumer_name,
          messageId: row.message_id,
          payloadHash: row.payload_hash,
          receivedAt: row.received_at,
          processedAt: row.processed_at ?? undefined,
        }
      : undefined;
  }
}

export class TypeOrmOutboxRepository {
  constructor(private readonly manager: EntityManager) {}
  async insert(message: OutboxRecord): Promise<void> {
    requireTransaction(this.manager);
    await this.manager.query(
      'INSERT INTO outbox_messages(id,aggregate_id,event_type,payload,occurred_at,attempts,next_attempt_at,published_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)',
      [
        message.id,
        message.aggregateId,
        message.eventType,
        JSON.stringify(message.payload),
        message.occurredAt,
        message.attempts,
        message.nextAttemptAt ?? null,
        message.publishedAt ?? null,
      ],
    );
  }
  async lockDue(now: Date, limit: number): Promise<OutboxRecord[]> {
    requireTransaction(this.manager);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Invalid outbox limit');
    const rows = await this.manager
      .createQueryBuilder(OutboxRowSchema, 'message')
      .where(
        'message.published_at IS NULL AND (message.next_attempt_at IS NULL OR message.next_attempt_at <= :now)',
        { now },
      )
      .orderBy('message.next_attempt_at', 'ASC', 'NULLS FIRST')
      .addOrderBy('message.occurred_at', 'ASC')
      .addOrderBy('message.id', 'ASC')
      .take(limit)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getMany();
    return rows.map((row) => ({
      id: row.id,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload,
      occurredAt: row.occurred_at,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at ?? undefined,
      publishedAt: row.published_at ?? undefined,
    }));
  }
}

export class TypeOrmFinancialTransaction implements FinancialTransaction {
  constructor(private readonly source: DataSource) {}
  run<T>(work: (context: FinancialContext) => Promise<T>): Promise<T> {
    return this.source.transaction('READ COMMITTED', (manager) =>
      work({
        wallets: new TypeOrmWalletRepository(manager),
        transactions: new TypeOrmWagerTransactionRepository(manager),
        ledger: new TypeOrmLedgerRepository(manager),
        inbox: new TypeOrmInboxRepository(manager),
        outbox: new TypeOrmOutboxRepository(manager),
      }),
    );
  }
}
