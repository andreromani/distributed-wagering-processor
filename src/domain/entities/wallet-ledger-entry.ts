import { Money } from '../value-objects/money.js';
import { LedgerDirection, FailureCode } from '../financial.types.js';
import { FinancialRuleError } from '../errors/financial-rule.error.js';
import { timestamp } from '../errors/timestamp.js';

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;

  readonly #createdAt: number;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;

    this.#createdAt = timestamp(state.createdAt);

    Object.freeze(this);
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    if (!Object.values(LedgerDirection).includes(state.direction)) {
      throw new FinancialRuleError(FailureCode.InvalidLedger);
    }

    if (
      state.money.currency !== state.balanceBefore.currency ||
      state.money.currency !== state.balanceAfter.currency
    ) {
      throw new FinancialRuleError(FailureCode.CurrencyMismatch);
    }

    if (
      !state.money.isPositive() ||
      state.balanceBefore.isNegative() ||
      state.balanceAfter.isNegative()
    ) {
      throw new FinancialRuleError(FailureCode.InvalidAmount);
    }

    const entry = new WalletLedgerEntry(state);

    if (!entry.isBalanced()) {
      throw new FinancialRuleError(FailureCode.InvalidLedger);
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  get createdAt(): Date {
    return new Date(this.#createdAt);
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);

    return expected.equals(this.balanceAfter);
  }
}
