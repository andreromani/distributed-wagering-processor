import type { FinancialContext } from '../ports/financial-context.js';
import type { FinancialRuntime } from '../ports/financial-runtime.js';
import type { Wallet } from '../../domain/entities/wallet.js';
import type { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.js';
import type { WagerTransaction } from '../../domain/entities/wager-transaction.js';
import { OutboxMessage } from '../../domain/entities/outbox-message.js';
import { WagerTransactionStatus as Status } from '../../domain/financial.types.js';
import {
  WagerTransactionProcessed,
  type WagerEventData,
} from '../../domain/events/wager-transaction-processed.event.js';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected.event.js';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference.event.js';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed.event.js';

export interface EventContext {
  source?: 'http' | 'sqs' | 'reference';
  correlationId?: string;
  causationId?: string;
}

export async function persistFinancialEvents(
  context: FinancialContext,
  tx: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  metadata: EventContext,
  at: Date,
  runtime: FinancialRuntime,
): Promise<void> {
  const envelope = {
    aggregateId: wallet.id,
    correlationId: metadata.correlationId ?? tx.id,
    causationId: metadata.causationId,
    occurredAt: at,
  };
  const data: WagerEventData = {
    transactionId: tx.id,
    walletId: wallet.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    kind: tx.kind,
    status: tx.status,
    money: tx.money.toJSON(),
    ...(tx.failureCode === undefined ? {} : { failureCode: tx.failureCode }),
    ...(tx.referenceTransactionId === undefined
      ? {}
      : { referenceTransactionId: tx.referenceTransactionId }),
  };
  const props = { ...envelope, eventId: runtime.id(), data };
  const event =
    tx.status === Status.Processed
      ? WagerTransactionProcessed.from(props)
      : tx.status === Status.Rejected
        ? WagerTransactionRejected.from(props)
        : WagerTransactionPendingReference.from(props);

  await context.outbox.insert(OutboxMessage.enqueue(event));

  if (entry) {
    await context.outbox.insert(
      OutboxMessage.enqueue(
        WalletBalanceChanged.from({
          ...envelope,
          eventId: runtime.id(),
          data: {
            walletId: wallet.id,
            transactionId: tx.id,
            direction: entry.direction,
            money: entry.money.toJSON(),
            balanceBefore: entry.balanceBefore.toJSON(),
            balanceAfter: entry.balanceAfter.toJSON(),
            walletVersion: wallet.version,
          },
        }),
      ),
    );
  }
}
