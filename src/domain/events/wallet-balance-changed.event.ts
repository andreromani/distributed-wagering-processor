import {
  IntegrationEvent,
  type IntegrationEventProps,
} from './integration-event.js';
import type { MoneyProps } from '../value-objects/money.js';
import type { LedgerDirection } from '../financial.types.js';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
    Object.freeze(this);
  }

  static from(
    props: IntegrationEventProps<WalletBalanceChangedData>,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged(props);
  }
}
