export class InvalidTransactionStateError extends Error {
  constructor() {
    super('Transaction state does not allow this transition');
    this.name = 'InvalidTransactionStateError';
  }
}
