export class InvalidCurrencyError extends Error {
  constructor() {
    super('Supported currencies are BRL and USD');
    this.name = 'InvalidCurrencyError';
  }
}
