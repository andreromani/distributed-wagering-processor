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
  readonly #state: Readonly<Omit<LedgerEntryState, 'createdAt'>>;
  readonly #createdAt: number;

  private constructor(state: LedgerEntryState) {
    const { createdAt, ...fields } = state;

    this.#state = Object.freeze(fields);
    this.#createdAt = timestamp(createdAt);
    Object.freeze(this);
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    if (!Object.values(LedgerDirection).includes(state.direction))
      throw new FinancialRuleError(FailureCode.InvalidLedger);
    if (
      state.money.currency !== state.balanceBefore.currency ||
      state.money.currency !== state.balanceAfter.currency
    )
      throw new FinancialRuleError(FailureCode.CurrencyMismatch);
    if (
      !state.money.isPositive() ||
      state.balanceBefore.isNegative() ||
      state.balanceAfter.isNegative()
    )
      throw new FinancialRuleError(FailureCode.InvalidAmount);

    const entry = new WalletLedgerEntry(state);
    if (!entry.isBalanced())
      throw new FinancialRuleError(FailureCode.InvalidLedger);

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  get id() {
    return this.#state.id;
  }

  get walletId() {
    return this.#state.walletId;
  }

  get transactionId() {
    return this.#state.transactionId;
  }

  get direction() {
    return this.#state.direction;
  }

  get money() {
    return this.#state.money;
  }

  get balanceBefore() {
    return this.#state.balanceBefore;
  }

  get balanceAfter() {
    return this.#state.balanceAfter;
  }

  get createdAt() {
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
