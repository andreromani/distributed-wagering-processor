export class CurrencyMismatchError extends Error {
  constructor() {
    super('Money currencies must match');
    this.name = 'CurrencyMismatchError';
  }
}
