import { Money } from '../value-objects/money.js';
import {
  FailureCode,
  LedgerDirection,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../financial.types.js';
import { FinancialRuleError } from '../errors/financial-rule.error.js';
import { InvalidTransactionStateError } from '../errors/invalid-transaction-state.error.js';
import { timestamp } from '../errors/timestamp.js';
import type { Wallet } from './wallet.js';
import type { WalletLedgerEntry } from './wallet-ledger-entry.js';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: Status;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  createdAt: Date;
}

export class WagerTransaction {
  readonly #props: Readonly<Omit<CreateWagerTransactionProps, 'createdAt'>>;
  readonly #createdAt: number;
  #status: Status;
  #referenceTransactionId: string | undefined;
  #failureCode: FailureCode | undefined;
  #processedAt: number | undefined;

  private constructor(state: WagerTransactionState) {
    const {
      status,
      referenceTransactionId,
      failureCode,
      processedAt,
      createdAt,
      ...props
    } = state;

    this.#props = Object.freeze(props);
    this.#createdAt = timestamp(createdAt);
    this.#status = status;
    this.#referenceTransactionId = referenceTransactionId;
    this.#failureCode = failureCode;
    this.#processedAt =
      processedAt === undefined ? undefined : timestamp(processedAt);
    Object.freeze(this);
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === Kind.Opening)
      throw new FinancialRuleError(FailureCode.ExternalOpeningForbidden);

    return WagerTransaction.newPending(props);
  }

  static opening(props: OpeningTransactionProps): WagerTransaction {
    return WagerTransaction.newPending({
      ...props,
      kind: Kind.Opening,
      providerId: 'internal',
      externalTransactionId: props.id,
      idempotencyKey: 'opening:' + props.walletId,
      roundId: 'opening:' + props.walletId,
      gameId: 'internal',
    });
  }

  private static newPending(
    props: CreateWagerTransactionProps,
  ): WagerTransaction {
    if (!Object.values(Kind).includes(props.kind))
      throw new FinancialRuleError(FailureCode.InvalidKind);
    // LOSS records an outcome and accepts any nonnegative amount.
    if (
      props.money.isNegative() ||
      (props.kind !== Kind.Loss && !props.money.isPositive())
    )
      throw new FinancialRuleError(FailureCode.InvalidAmount);
    if (
      (props.kind === Kind.Refund || props.kind === Kind.Rollback) &&
      !props.referenceExternalTransactionId?.trim()
    )
      throw new FinancialRuleError(FailureCode.InvalidReference);

    return new WagerTransaction({ ...props, status: Status.Pending });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get id() {
    return this.#props.id;
  }

  get providerId() {
    return this.#props.providerId;
  }

  get externalTransactionId() {
    return this.#props.externalTransactionId;
  }

  get idempotencyKey() {
    return this.#props.idempotencyKey;
  }

  get payloadHash() {
    return this.#props.payloadHash;
  }

  get walletId() {
    return this.#props.walletId;
  }

  get playerId() {
    return this.#props.playerId;
  }

  get roundId() {
    return this.#props.roundId;
  }

  get gameId() {
    return this.#props.gameId;
  }

  get kind() {
    return this.#props.kind;
  }

  get money() {
    return this.#props.money;
  }

  get referenceExternalTransactionId() {
    return this.#props.referenceExternalTransactionId;
  }

  get createdAt() {
    return new Date(this.#createdAt);
  }

  get status() {
    return this.#status;
  }

  get referenceTransactionId() {
    return this.#referenceTransactionId;
  }

  get failureCode() {
    return this.#failureCode;
  }

  get processedAt() {
    return this.#processedAt === undefined
      ? undefined
      : new Date(this.#processedAt);
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertMutable();
    if (this.requiresReference() && !referenceTransactionId)
      throw new FinancialRuleError(FailureCode.InvalidReference);

    const processedAt = timestamp(at);

    this.#referenceTransactionId = referenceTransactionId;
    this.#processedAt = processedAt;
    this.#status = Status.Processed;
  }

  markPendingReference(): void {
    this.assertMutable();
    if (!this.referenceExternalTransactionId)
      throw new InvalidTransactionStateError();

    this.#status = Status.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertMutable();

    this.#failureCode = code;
    this.#status = Status.Rejected;
  }

  fail(code: FailureCode): void {
    this.assertMutable();

    this.#failureCode = code;
    this.#status = Status.Failed;
  }

  isTerminal(): boolean {
    return [Status.Processed, Status.Rejected, Status.Failed].includes(
      this.status,
    );
  }

  affectsBalance(): boolean {
    return this.kind !== Kind.Loss && !this.money.isZero();
  }

  requiresReference(): boolean {
    return this.kind === Kind.Refund || this.kind === Kind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  validateReference(reference: WagerTransaction): void {
    if (
      reference.id === this.id ||
      reference.externalTransactionId !== this.referenceExternalTransactionId ||
      reference.status !== Status.Processed
    )
      throw new FinancialRuleError(FailureCode.InvalidReference);
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.money.currency !== this.money.currency ||
      reference.roundId !== this.roundId
    )
      throw new FinancialRuleError(FailureCode.ReferenceContextMismatch);

    const allowed =
      this.kind === Kind.Rollback
        ? [Kind.Bet, Kind.Win, Kind.Refund]
        : [Kind.Bet];
    if (!allowed.includes(reference.kind))
      throw new FinancialRuleError(FailureCode.InvalidReferenceKind);
    if (this.requiresReference() && !this.money.equals(reference.money))
      throw new FinancialRuleError(FailureCode.ReferenceAmountMismatch);
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (!this.affectsBalance())
      throw new FinancialRuleError(FailureCode.InvalidLedger);
    if (this.requiresReference()) {
      if (!reference)
        throw new FinancialRuleError(FailureCode.ReferenceNotFound);

      this.validateReference(reference);
      if (this.kind === Kind.Rollback)
        return reference.kind === Kind.Bet
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
    }

    return this.kind === Kind.Bet
      ? LedgerDirection.Debit
      : LedgerDirection.Credit;
  }
  /** Applies only local financial rules. Callers resolve references and prior reversals. */

  applyTo(
    wallet: Wallet,
    context: { ledgerEntryId: string; at: Date },
    reference?: WagerTransaction,
  ): WalletLedgerEntry | undefined {
    this.assertMutable();
    timestamp(context.at);
    if (reference && !this.referenceExternalTransactionId)
      throw new FinancialRuleError(FailureCode.InvalidReference);
    if (wallet.id !== this.walletId || wallet.playerId !== this.playerId)
      throw new FinancialRuleError(FailureCode.ReferenceContextMismatch);
    if (wallet.currency !== this.money.currency)
      throw new FinancialRuleError(FailureCode.CurrencyMismatch);
    if (this.referenceExternalTransactionId) {
      if (!reference) {
        this.markPendingReference();

        return undefined;
      }

      this.validateReference(reference);
    }
    if (!this.affectsBalance()) {
      this.markProcessed(reference?.id, context.at);

      return undefined;
    }

    const direction = this.ledgerDirectionFor(reference);
    if (
      direction === LedgerDirection.Debit &&
      wallet.balance.isLessThan(this.money)
    )
      throw new FinancialRuleError(
        this.kind === Kind.Rollback
          ? FailureCode.InsufficientReversalFunds
          : FailureCode.InsufficientFunds,
      );

    const movement = { ...context, transactionId: this.id };

    const entry =
      direction === LedgerDirection.Debit
        ? wallet.debit(this.money, movement)
        : wallet.credit(this.money, movement);
    this.markProcessed(reference?.id, context.at);

    return entry;
  }

  private assertMutable(): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError();
  }
}
