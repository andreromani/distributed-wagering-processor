import { Money } from '../value-objects/money.js';
import { WalletLedgerEntry } from './wallet-ledger-entry.js';
import { WagerTransaction } from './wager-transaction.js';
import { FailureCode, LedgerDirection } from '../financial.types.js';
import { FinancialRuleError, timestamp } from '../errors/financial.errors.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementContext {
  transactionId: string;
  ledgerEntryId: string;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  opening?: {
    transactionId: string;
    ledgerEntryId: string;
    payloadHash: string;
  };
}

export class Wallet {
  readonly #identity: Readonly<
    Pick<WalletState, 'id' | 'playerId' | 'currency'>
  >;
  readonly #createdAt: number;
  #balance: Money;
  #version: number;
  #updatedAt: number;

  private constructor(state: WalletState) {
    this.#identity = Object.freeze({
      id: state.id,
      playerId: state.playerId,
      currency: state.currency,
    });
    this.#balance = state.balance;
    this.#version = state.version;
    this.#createdAt = timestamp(state.createdAt);
    this.#updatedAt = timestamp(state.updatedAt);
    Object.freeze(this);
  }

  static open(props: OpenWalletProps): {
    wallet: Wallet;
    openingTransaction?: WagerTransaction;
    openingEntry?: WalletLedgerEntry;
  } {
    if (props.initialBalance.isNegative())
      throw new FinancialRuleError(FailureCode.InvalidAmount);
    const wallet = new Wallet({
      id: props.id,
      playerId: props.playerId,
      currency: props.initialBalance.currency,
      balance: props.initialBalance,
      version: 1,
      createdAt: props.at,
      updatedAt: props.at,
    });
    if (props.initialBalance.isZero()) return { wallet };
    if (!props.opening)
      throw new FinancialRuleError(FailureCode.InvalidReference);
    const openingTransaction = WagerTransaction.opening({
      id: props.opening.transactionId,
      walletId: props.id,
      playerId: props.playerId,
      money: props.initialBalance,
      createdAt: props.at,
      payloadHash: props.opening.payloadHash,
    });
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.ledgerEntryId,
      walletId: props.id,
      transactionId: openingTransaction.id,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: wallet.balance,
      createdAt: props.at,
    });
    openingTransaction.markProcessed(undefined, props.at);
    return { wallet, openingTransaction, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  get id() {
    return this.#identity.id;
  }

  get playerId() {
    return this.#identity.playerId;
  }

  get currency() {
    return this.#identity.currency;
  }

  get balance() {
    return this.#balance;
  }

  get version() {
    return this.#version;
  }

  get createdAt() {
    return new Date(this.#createdAt);
  }

  get updatedAt() {
    return new Date(this.#updatedAt);
  }

  debit(money: Money, context: MovementContext): WalletLedgerEntry {
    this.assertMovement(money);
    if (this.balance.isLessThan(money))
      throw new FinancialRuleError(FailureCode.InsufficientFunds);
    return this.move(
      money,
      this.balance.subtract(money),
      LedgerDirection.Debit,
      context,
    );
  }

  credit(money: Money, context: MovementContext): WalletLedgerEntry {
    this.assertMovement(money);
    return this.move(
      money,
      this.balance.add(money),
      LedgerDirection.Credit,
      context,
    );
  }

  private move(
    money: Money,
    balanceAfter: Money,
    direction: LedgerDirection,
    context: MovementContext,
  ): WalletLedgerEntry {
    const at = timestamp(context.at);
    const entry = WalletLedgerEntry.create({
      id: context.ledgerEntryId,
      transactionId: context.transactionId,
      walletId: this.id,
      money,
      balanceBefore: this.balance,
      balanceAfter,
      direction,
      createdAt: context.at,
    });
    this.#balance = balanceAfter;
    this.#version += 1;
    this.#updatedAt = at;
    return entry;
  }
  
  private assertMovement(money: Money): void {
    if (money.currency !== this.currency)
      throw new FinancialRuleError(FailureCode.CurrencyMismatch);
    if (!money.isPositive())
      throw new FinancialRuleError(FailureCode.InvalidAmount);
  }
}
