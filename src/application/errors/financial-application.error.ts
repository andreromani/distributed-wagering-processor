export type FinancialApplicationCode =
  | 'INVALID_INPUT'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_CONFLICT'
  | 'CONTEXT_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EXTERNAL_IDENTITY_CONFLICT'
  | 'INBOX_CONFLICT'
  | 'TRANSACTION_NOT_FOUND'
  | 'TRANSIENT_FAILURE'
  | 'PERMANENT_FAILURE';

export class FinancialApplicationError extends Error {
  constructor(
    readonly code: FinancialApplicationCode,
    readonly operationId?: string,
  ) {
    super(code);
    this.name = 'FinancialApplicationError';
  }
}
