export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  InsufficientReversalFunds = 'INSUFFICIENT_REVERSAL_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InvalidAmount = 'INVALID_AMOUNT',
  InvalidReference = 'INVALID_REFERENCE',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  InvalidKind = 'INVALID_KIND',
  ExternalOpeningForbidden = 'EXTERNAL_OPENING_FORBIDDEN',
  InvalidLedger = 'INVALID_LEDGER',
  InvalidTimestamp = 'INVALID_TIMESTAMP',
  PermanentInfrastructureFailure = 'PERMANENT_INFRASTRUCTURE_FAILURE',
}
