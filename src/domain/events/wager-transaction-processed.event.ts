import {
  IntegrationEvent,
  type IntegrationEventProps,
} from './integration-event.js';
import type { MoneyProps } from '../value-objects/money.js';
import type {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../financial.types.js';

export interface WagerEventData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  failureCode?: FailureCode;
  referenceTransactionId?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerEventData>) {
    super(props);
    Object.freeze(this);
  }

  static from(
    props: IntegrationEventProps<WagerEventData>,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed(props);
  }
}
