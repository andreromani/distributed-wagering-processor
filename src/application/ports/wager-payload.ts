import type { MoneyProps } from '../../domain/value-objects/money.js';
import type { WagerTransactionKind } from '../../domain/financial.types.js';

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}
