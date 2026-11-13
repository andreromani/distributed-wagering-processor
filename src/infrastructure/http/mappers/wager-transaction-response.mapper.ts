import type { StoredWager } from '../../../domain/repositories/wager-transaction.repository.js';
import type { ProcessWagerResult } from '../../../application/use-cases/process-wager-transaction.use-case.js';
import { WagerTransactionStatus as Status } from '../../../domain/financial.types.js';

export function processingStatus(status: Status): number {
  switch (status) {
    case Status.Processed:
      return 200;
    case Status.Pending:
    case Status.PendingReference:
      return 202;
    case Status.Rejected:
      return 422;
    case Status.Failed:
      return 500;
  }
}

export function processingResponse(
  result: ProcessWagerResult,
): Omit<ProcessWagerResult, 'canAcknowledge'> {
  return {
    transactionId: result.transactionId,
    status: result.status,
    idempotentReplay: result.idempotentReplay,
    createdAt: result.createdAt,
    ...(result.failureCode === undefined
      ? {}
      : { failureCode: result.failureCode }),
    ...(result.balance === undefined
      ? {}
      : {
          balance: {
            amount: result.balance.amount,
            currency: result.balance.currency,
          },
        }),
    ...(result.walletVersion === undefined
      ? {}
      : { walletVersion: result.walletVersion }),
    ...(result.referenceTransactionId === undefined
      ? {}
      : { referenceTransactionId: result.referenceTransactionId }),
    ...(result.processedAt === undefined
      ? {}
      : { processedAt: result.processedAt }),
  };
}

export function wagerResponse(stored: StoredWager) {
  const tx = stored.transaction;
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    createdAt: tx.createdAt.toISOString(),
    ...(tx.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: tx.referenceExternalTransactionId }),
    ...(tx.referenceTransactionId === undefined
      ? {}
      : { referenceTransactionId: tx.referenceTransactionId }),
    ...(tx.failureCode === undefined ? {} : { failureCode: tx.failureCode }),
    ...(tx.processedAt === undefined
      ? {}
      : { processedAt: tx.processedAt.toISOString() }),
    ...(stored.result === undefined
      ? {}
      : {
          balance: stored.result.balance.toJSON(),
          walletVersion: stored.result.version,
        }),
  };
}
